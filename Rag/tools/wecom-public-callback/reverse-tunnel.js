const { spawn } = require('node:child_process')
const path = require('node:path')

const CLI_OPTIONS = Object.freeze({
  '--ssh-host': 'sshHost',
  '--ssh-port': 'sshPort',
  '--ssh-user': 'sshUser',
  '--identity-file': 'identityFile',
  '--remote-port': 'remotePort',
  '--local-port': 'localPort'
})

function requiredText(value, name, pattern) {
  const text = String(value || '').trim()
  if (!text || (pattern && !pattern.test(text))) {
    throw new Error(`${name} is invalid`)
  }
  return text
}

function validateConfig(input = {}) {
  const config = {
    sshHost: requiredText(input.sshHost, 'sshHost', /^[A-Za-z0-9.-]+$/),
    sshPort: Number(input.sshPort ?? 22),
    sshUser: requiredText(input.sshUser ?? 'wecom-tunnel', 'sshUser', /^[A-Za-z_][A-Za-z0-9_-]*$/),
    identityFile: path.resolve(requiredText(input.identityFile, 'identityFile')),
    remotePort: Number(input.remotePort ?? 18788),
    localPort: Number(input.localPort ?? 8788)
  }

  if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535) {
    throw new Error('sshPort is invalid')
  }
  if (config.remotePort !== 18788) {
    throw new Error('remotePort must be 18788')
  }
  if (config.localPort !== 8788) {
    throw new Error('localPort must be 8788')
  }
  return config
}

function buildSshArguments(input) {
  const config = validateConfig(input)
  return [
    '-N',
    '-T',
    '-p', String(config.sshPort),
    '-i', config.identityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=yes',
    '-R', `127.0.0.1:${config.remotePort}:127.0.0.1:${config.localPort}`,
    `${config.sshUser}@${config.sshHost}`
  ]
}

function reconnectDelayMs(attempt) {
  const exponent = Math.max(0, Number(attempt) || 0)
  return Math.min(1000 * (2 ** exponent), 30000)
}

function parseCliArguments(argv = []) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const property = CLI_OPTIONS[option]
    if (!property) {
      throw new Error(`Unknown option: ${option}`)
    }
    if (Object.hasOwn(parsed, property)) {
      throw new Error(`Duplicate option: ${option}`)
    }

    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a value`)
    }
    parsed[property] = value
  }
  return parsed
}

function writeEvent(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`)
}

function runSupervisor(input, dependencies = {}) {
  const config = validateConfig(input)
  const spawnProcess = dependencies.spawnProcess || spawn
  const schedule = dependencies.schedule || setTimeout
  const cancelSchedule = dependencies.cancelSchedule || clearTimeout
  const signalSource = dependencies.signalSource || process
  const exitProcess = dependencies.exitProcess || (code => process.exit(code))
  const logEvent = dependencies.logEvent || writeEvent

  let attempt = 0
  let child = null
  let retryTimer = null
  let shuttingDown = false

  function scheduleReconnect() {
    if (shuttingDown) {
      exitProcess(0)
      return
    }
    const retryDelayMs = reconnectDelayMs(attempt)
    attempt += 1
    logEvent('tunnel.retry_scheduled', { retryDelayMs })
    retryTimer = schedule(connect, retryDelayMs)
  }

  function connect() {
    retryTimer = null
    if (shuttingDown) return

    logEvent('tunnel.starting')
    let settled = false
    try {
      child = spawnProcess('ssh.exe', buildSshArguments(config), {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      child = null
      logEvent('tunnel.spawn_error')
      scheduleReconnect()
      return
    }

    function finish(exitCode) {
      if (settled) return
      settled = true
      child = null
      if (exitCode !== undefined) {
        logEvent('tunnel.exited', { exitCode: Number.isInteger(exitCode) ? exitCode : null })
      }
      scheduleReconnect()
    }

    child.once('error', () => {
      logEvent('tunnel.spawn_error')
      finish()
    })
    child.once('exit', finish)
  }

  function stop() {
    if (shuttingDown) return
    shuttingDown = true
    logEvent('tunnel.stopping')
    if (retryTimer) {
      cancelSchedule(retryTimer)
      retryTimer = null
    }
    if (child) {
      child.kill()
      return
    }
    exitProcess(0)
  }

  signalSource.once('SIGINT', stop)
  signalSource.once('SIGTERM', stop)
  connect()

  return { stop }
}

if (require.main === module) {
  try {
    runSupervisor(parseCliArguments(process.argv.slice(2)))
  } catch {
    writeEvent('tunnel.configuration_error')
    process.exitCode = 1
  }
}

module.exports = {
  buildSshArguments,
  parseCliArguments,
  reconnectDelayMs,
  runSupervisor,
  validateConfig
}
