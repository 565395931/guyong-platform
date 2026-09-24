const { WebSocket, WebSocketServer } = require('ws')
const {
  BridgeProtocolError,
  MAX_FRAME_BYTES,
  createAck,
  createEvent,
  parseEnvelope
} = require('./bridgeProtocol')
const { ConnectionRegistry } = require('./connectionRegistry')

class BridgeGatewayError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeGatewayError'
    this.code = code
  }
}

function createBridgeGateway({
  httpServer,
  repository,
  pairingService,
  leaseService,
  inboundService,
  commandStatusService,
  configurationProvider = async () => ({}),
  environment = process.env.NODE_ENV || 'development',
  allowInsecureLan = process.env.BRIDGE_ALLOW_INSECURE_LAN === 'true',
  tlsEnabled = Boolean(process.env.BRIDGE_TLS_ENABLED === 'true'),
  enabled = true,
  registry = new ConnectionRegistry()
}) {
  if (!httpServer) throw new TypeError('httpServer is required')
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  let started = false

  function closePolicy(socket, reason) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1008, String(reason || 'Policy violation').slice(0, 120))
  }

  function send(socket, envelope) {
    if (socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(envelope))
    return true
  }

  async function handleHello(session, envelope) {
    const payload = envelope.payload
    let node
    let enrollmentToken
    if (payload.pairingCode) {
      const paired = await pairingService.consume({
        code: payload.pairingCode,
        machineFingerprint: payload.machineFingerprint,
        displayName: payload.displayName,
        version: payload.version,
        adapterIds: payload.adapterIds,
        capabilities: payload.capabilities
      })
      node = { id: paired.nodeId, node_key: paired.nodeKey }
      enrollmentToken = paired.enrollmentToken
    } else {
      if (!envelope.nodeId) throw new BridgeGatewayError('NODE_ID_REQUIRED', 'Enrolled node id is required')
      node = await repository.authenticateNode({
        nodeKey: envelope.nodeId,
        enrollmentToken: payload.enrollmentToken,
        machineFingerprint: payload.machineFingerprint
      })
      if (!node) throw new BridgeGatewayError('NODE_AUTH_FAILED', 'Node is disabled or credentials are invalid')
    }

    session.nodeId = node.node_key
    session.databaseNodeId = node.id
    session.ready = true
    registry.register(session.nodeId, {
      socket: session.socket,
      databaseNodeId: session.databaseNodeId,
      connectedAt: new Date()
    })
    await repository.touchNode?.(session.databaseNodeId, {
      version: payload.version,
      capabilities: payload.capabilities,
      status: 'online'
    })
    const configuration = await configurationProvider({
      nodeId: session.nodeId,
      databaseNodeId: session.databaseNodeId
    })
    if (enrollmentToken) configuration.enrollmentToken = enrollmentToken
    send(session.socket, createEvent({
      type: 'node.ready',
      nodeId: session.nodeId,
      payload: { serverTime: new Date().toISOString(), configuration }
    }))
  }

  async function handleHeartbeat(session, envelope) {
    for (const lease of envelope.payload.leases || []) {
      await leaseService.renew({
        accountId: lease.accountId,
        nodeId: session.databaseNodeId,
        leaseToken: lease.leaseToken,
        generation: lease.generation
      })
    }
    await repository.touchNode?.(session.databaseNodeId, { status: 'online' })
    send(session.socket, createAck({
      nodeId: session.nodeId,
      ackForEventId: envelope.eventId,
      status: 'processed'
    }))
  }

  async function handleReadyMessage(session, envelope) {
    if (envelope.nodeId !== session.nodeId) {
      throw new BridgeGatewayError('NODE_ID_MISMATCH', 'Envelope node id does not match the authenticated node')
    }
    if (envelope.type === 'node.heartbeat') return handleHeartbeat(session, envelope)

    let result = { status: 'processed' }
    if (envelope.type === 'message.inbound') {
      result = await inboundService?.handle?.({
        envelope,
        nodeId: session.databaseNodeId,
        nodeKey: session.nodeId
      }) || result
    } else if (envelope.type === 'message.command.status') {
      result = await commandStatusService?.handle?.({
        envelope,
        nodeId: session.databaseNodeId,
        nodeKey: session.nodeId
      }) || result
    } else if (!['account.snapshot', 'account.state.changed'].includes(envelope.type)) {
      throw new BridgeGatewayError('MESSAGE_TYPE_NOT_ALLOWED', `Node cannot send ${envelope.type}`)
    }

    send(session.socket, createAck({
      nodeId: session.nodeId,
      ackForEventId: envelope.eventId,
      status: result.status || 'processed',
      errorCode: result.errorCode,
      message: result.message
    }))
  }

  async function handleFrame(session, data) {
    let envelope
    try {
      envelope = parseEnvelope(data)
      if (!session.ready) {
        if (envelope.type !== 'node.hello') {
          throw new BridgeGatewayError('HELLO_REQUIRED', 'node.hello must be the first message')
        }
        await handleHello(session, envelope)
      } else {
        await handleReadyMessage(session, envelope)
      }
    } catch (error) {
      const reason = error instanceof BridgeProtocolError ? error.code : error.code || 'BRIDGE_REQUEST_FAILED'
      closePolicy(session.socket, reason)
    }
  }

  wss.on('connection', socket => {
    const session = { socket, ready: false, nodeId: null, databaseNodeId: null, queue: Promise.resolve() }
    socket.on('error', () => {})
    socket.on('message', data => {
      session.queue = session.queue.then(() => handleFrame(session, data)).catch(() => {})
    })
    socket.on('close', () => {
      if (session.nodeId) registry.remove(session.nodeId, socket)
      if (session.databaseNodeId) {
        repository.touchNode?.(session.databaseNodeId, { status: 'offline' }).catch?.(() => {})
      }
    })
  })

  const onUpgrade = (request, socket, head) => {
    let pathname
    try {
      pathname = new URL(request.url, 'http://bridge.local').pathname
    } catch {
      return
    }
    if (pathname !== '/bridge/v1') return
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  }

  return {
    start() {
      if (!enabled || started) return this
      if (environment === 'production' && !tlsEnabled && !allowInsecureLan) {
        throw new BridgeGatewayError('BRIDGE_TLS_REQUIRED', 'Desktop bridge requires TLS in production')
      }
      httpServer.on('upgrade', onUpgrade)
      started = true
      return this
    },

    async stop() {
      if (!started) return
      started = false
      httpServer.off('upgrade', onUpgrade)
      registry.closeAll(1001, 'Server shutting down')
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          for (const socket of wss.clients) socket.terminate()
        }, 100)
        timer.unref?.()
        wss.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },

    sendToNode(nodeId, envelope) {
      const connection = registry.get(nodeId)
      if (!connection) throw new BridgeGatewayError('NODE_OFFLINE', 'Desktop node is offline')
      return send(connection.socket, parseEnvelope(envelope))
    },

    getConnection(nodeId) {
      return registry.get(nodeId)
    }
  }
}

module.exports = { BridgeGatewayError, createBridgeGateway }
