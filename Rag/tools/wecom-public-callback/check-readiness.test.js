const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { assessReadiness, parseCliArguments, redactDiagnostic } = require('./check-readiness')

test('requires local gateway, DNS, valid TLS, public HTTPS, and ECS tunnel health', () => {
  const ready = assessReadiness({ localGateway: true, dns: true, tls: true, https: true, ecsTunnel: true })
  assert.deepEqual(ready, { ready: true, failed: [] })
  assert.deepEqual(
    assessReadiness({ localGateway: true, dns: false, tls: false, https: false, ecsTunnel: true }).failed,
    ['dns', 'tls', 'https']
  )
})

test('redacts URLs, query strings, and token-shaped diagnostics', () => {
  const value = redactDiagnostic('GET https://host/path?msg_signature=abc token=secret')
  assert.doesNotMatch(value, /abc|secret|msg_signature/)
})

test('parses SSH readiness options with default and explicit ports', () => {
  assert.deepEqual(
    parseCliArguments([
      '--domain', 'wecom.thelonelybrave.cn',
      '--ssh-host', 'ecs.example.test',
      '--ssh-user', 'wecom-probe',
      '--identity-file', 'data/wecom-probe/id_ed25519'
    ]),
    {
      domain: 'wecom.thelonelybrave.cn',
      sshHost: 'ecs.example.test',
      sshPort: 22,
      sshUser: 'wecom-probe',
      identityFile: require('node:path').resolve('data/wecom-probe/id_ed25519')
    }
  )
  assert.equal(
    parseCliArguments([
      '--ssh-host', 'ecs.example.test',
      '--ssh-port', '2222',
      '--ssh-user', 'wecom-probe',
      '--identity-file', 'data/wecom-probe/id_ed25519'
    ]).sshPort,
    2222
  )
  assert.throws(
    () => parseCliArguments(['--ssh-host', 'ecs.example.test', '--ssh-port', '22']),
    /SSH probe requires/
  )
})

test('TLS probe fails closed when the socket closes before handshake', async () => {
  const { checkTls } = require('./check-readiness')
  const socket = new EventEmitter()
  socket.setTimeout = () => {}
  socket.destroy = () => {}
  const result = checkTls('wecom.example.test', { connect: () => socket })
  socket.emit('close')
  assert.equal(await result, false)
})
