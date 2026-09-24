const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const {
  buildSshArguments,
  parseCliArguments,
  reconnectDelayMs,
  runSupervisor,
  validateConfig
} = require('./reverse-tunnel')

const CONFIG = {
  sshHost: 'ecs.example.test',
  sshPort: 22,
  sshUser: 'wecom-tunnel',
  identityFile: 'E:\\secure\\wecom-tunnel\\id_ed25519',
  remotePort: 18788,
  localPort: 8788
}

test('builds a loopback-only SSH reverse forward with no shell', () => {
  const args = buildSshArguments(CONFIG)

  assert.ok(args.includes('-N'))
  assert.ok(args.includes('-T'))
  assert.ok(args.includes('127.0.0.1:18788:127.0.0.1:8788'))
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.equal(args.some(value => /0\.0\.0\.0:18788/.test(value)), false)
  assert.equal(args.at(-1), 'wecom-tunnel@ecs.example.test')
})

test('rejects unsafe host, user, port, and identity inputs', () => {
  assert.throws(() => validateConfig({ ...CONFIG, sshHost: 'host;shutdown' }), /sshHost/)
  assert.throws(() => validateConfig({ ...CONFIG, sshUser: 'root user' }), /sshUser/)
  assert.throws(() => validateConfig({ ...CONFIG, sshPort: 0 }), /sshPort/)
  assert.throws(() => validateConfig({ ...CONFIG, sshPort: 65536 }), /sshPort/)
  assert.throws(() => validateConfig({ ...CONFIG, remotePort: 443 }), /remotePort/)
  assert.throws(() => validateConfig({ ...CONFIG, localPort: 3001 }), /localPort/)
  assert.throws(() => validateConfig({ ...CONFIG, identityFile: '' }), /identityFile/)
})

test('applies only the approved tunnel defaults', () => {
  const config = validateConfig({
    sshHost: CONFIG.sshHost,
    identityFile: CONFIG.identityFile
  })

  assert.equal(config.sshPort, 22)
  assert.equal(config.sshUser, 'wecom-tunnel')
  assert.equal(config.remotePort, 18788)
  assert.equal(config.localPort, 8788)
  assert.ok(path.isAbsolute(config.identityFile))
})

test('uses bounded exponential reconnect delay', () => {
  assert.deepEqual([0, 1, 2, 8].map(reconnectDelayMs), [1000, 2000, 4000, 30000])
})

test('parses only the supported CLI flags', () => {
  assert.deepEqual(parseCliArguments([
    '--ssh-host', 'ecs.example.test',
    '--ssh-port', '2222',
    '--ssh-user', 'wecom-tunnel',
    '--identity-file', 'E:\\secure\\wecom-tunnel\\id_ed25519',
    '--remote-port', '18788',
    '--local-port', '8788'
  ]), {
    sshHost: 'ecs.example.test',
    sshPort: '2222',
    sshUser: 'wecom-tunnel',
    identityFile: 'E:\\secure\\wecom-tunnel\\id_ed25519',
    remotePort: '18788',
    localPort: '8788'
  })

  assert.throws(() => parseCliArguments(['--unknown', 'value']), /Unknown option/)
  assert.throws(() => parseCliArguments(['--ssh-host']), /requires a value/)
  assert.throws(() => parseCliArguments(['--ssh-host', 'one', '--ssh-host', 'two']), /Duplicate option/)
})

test('starts hidden SSH, ignores process streams, and schedules a sanitized retry', () => {
  const child = new EventEmitter()
  child.kill = () => true
  const signalSource = new EventEmitter()
  const spawnCalls = []
  const scheduled = []
  const events = []

  runSupervisor(CONFIG, {
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options })
      return child
    },
    schedule(callback, delay) {
      scheduled.push({ callback, delay })
      return scheduled.length
    },
    signalSource,
    logEvent(event, details) {
      events.push({ event, ...details })
    }
  })

  assert.equal(spawnCalls[0].command, 'ssh.exe')
  assert.deepEqual(spawnCalls[0].options, { windowsHide: true, stdio: 'ignore' })
  child.emit('exit', 255)
  assert.equal(scheduled[0].delay, 1000)
  assert.deepEqual(events.map(value => value.event), [
    'tunnel.starting',
    'tunnel.exited',
    'tunnel.retry_scheduled'
  ])
  assert.equal(events[1].exitCode, 255)
  assert.doesNotMatch(JSON.stringify(events), /ecs\.example\.test|id_ed25519|--identity-file/)
})

test('kills an active child on termination and does not reconnect', () => {
  const child = new EventEmitter()
  let killCount = 0
  child.kill = () => {
    killCount += 1
    return true
  }
  const signalSource = new EventEmitter()
  const scheduled = []
  const exitCodes = []

  runSupervisor(CONFIG, {
    spawnProcess: () => child,
    schedule(callback, delay) {
      scheduled.push({ callback, delay })
      return scheduled.length
    },
    signalSource,
    exitProcess: code => exitCodes.push(code),
    logEvent: () => {}
  })

  signalSource.emit('SIGTERM')
  child.emit('exit', 0)

  assert.equal(killCount, 1)
  assert.deepEqual(scheduled, [])
  assert.deepEqual(exitCodes, [0])
})

test('backs off after synchronous spawn failures and cancels a pending retry on shutdown', () => {
  const signalSource = new EventEmitter()
  const scheduled = []
  const cancelled = []
  const exitCodes = []
  const events = []

  runSupervisor(CONFIG, {
    spawnProcess() {
      throw new Error(`must not be logged: ${CONFIG.identityFile}`)
    },
    schedule(callback, delay) {
      const timer = { callback, delay }
      scheduled.push(timer)
      return timer
    },
    cancelSchedule: timer => cancelled.push(timer),
    signalSource,
    exitProcess: code => exitCodes.push(code),
    logEvent: (event, details) => events.push({ event, ...details })
  })

  assert.equal(scheduled[0].delay, 1000)
  scheduled[0].callback()
  assert.equal(scheduled[1].delay, 2000)
  signalSource.emit('SIGINT')

  assert.deepEqual(cancelled, [scheduled[1]])
  assert.deepEqual(exitCodes, [0])
  assert.doesNotMatch(JSON.stringify(events), /id_ed25519|must not be logged/)
})

test('does not include child-process error details in retry logs', () => {
  const child = new EventEmitter()
  child.kill = () => true
  const events = []
  const scheduled = []

  runSupervisor(CONFIG, {
    spawnProcess: () => child,
    schedule(callback, delay) {
      scheduled.push({ callback, delay })
      return scheduled.length
    },
    signalSource: new EventEmitter(),
    logEvent: (event, details) => events.push({ event, ...details })
  })
  child.emit('error', new Error(`private path: ${CONFIG.identityFile}`))

  assert.equal(scheduled[0].delay, 1000)
  assert.deepEqual(events.map(value => value.event), [
    'tunnel.starting',
    'tunnel.spawn_error',
    'tunnel.retry_scheduled'
  ])
  assert.doesNotMatch(JSON.stringify(events), /private path|id_ed25519/)
})

test('prints only a safe structured event for invalid CLI configuration', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'reverse-tunnel.js'),
    '--ssh-host', 'host;unsafe',
    '--identity-file', CONFIG.identityFile
  ], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { event: 'tunnel.configuration_error' })
  assert.equal(result.stderr, '')
  assert.doesNotMatch(result.stdout, /host;unsafe|id_ed25519/)
})
