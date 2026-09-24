const EventEmitter = require('events')
const { createHello, validateEnvelope } = require('./gatewayProtocol')

function loadWs() {
  try { return require('ws') } catch (error) {
    throw new Error('cloud_gateway requires the `ws` dependency to be installed')
  }
}

class GatewayLink extends EventEmitter {
  constructor(options = {}) {
    super()
    this.on('error', () => {})
    this.url = options.url || process.env.CLOUD_GATEWAY_URL || 'ws://127.0.0.1:8787'
    this.authToken = options.authToken || process.env.CLOUD_GATEWAY_AUTH_TOKEN
    this.authTokenProvider = options.authTokenProvider
    this.clientId = options.clientId || 'rag-server'
    this.lastCursor = options.lastCursor || 0
    this.heartbeatMs = options.heartbeatMs || 15000
    this.reconnectBaseMs = options.reconnectBaseMs || 500
    this.reconnectMaxMs = options.reconnectMaxMs || 30000
    this.WebSocket = options.WebSocket
    this.socket = null
    this.ready = false
    this.retryCount = 0
    this.stopped = true
    this.heartbeatTimer = null
    this.lastPongAt = Date.now()
    this.connectPromise = null
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || 5000
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise
    this.stopped = false
    const WebSocket = this.WebSocket || loadWs()
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = typeof WebSocket === 'function' ? new WebSocket(this.url) : WebSocket
      this.socket = socket
      let settled = false
      const settleResolve = () => { if (!settled) { settled = true; resolve() } }
      const settleReject = error => { if (!settled) { settled = true; reject(error) } }
      this._connectResolve = settleResolve
      this._connectReject = settleReject
      const onOpen = () => {
        this.ready = false
        this.lastPongAt = Date.now()
        try {
          const authToken = this.authTokenProvider ? this.authTokenProvider() : this.authToken
          if (!authToken) throw new Error('cloud gateway auth token is not configured')
          this.send(createHello({ authToken, clientId: this.clientId, lastCursor: this.lastCursor }))
          this.emit('connected')
          this.startHeartbeat()
        } catch (error) {
          settleReject(error)
          socket.close?.(1011, 'hello send failed')
        }
      }
      const onMessage = raw => this.handleMessage(raw)
      if (socket.on) {
        socket.on('open', onOpen)
        socket.on('message', onMessage)
        socket.on('close', () => this.handleClose())
        socket.on('error', error => { this.emit('error', error); settleReject(error) })
      } else if (socket.addEventListener) {
        socket.addEventListener('open', onOpen)
        socket.addEventListener('message', event => onMessage(event.data))
        socket.addEventListener('close', () => this.handleClose())
        socket.addEventListener('error', event => { const error = event.error || event; this.emit('error', error); settleReject(error) })
      }
      const handshakeTimer = setTimeout(() => {
        if (!settled) {
          const error = new Error('cloud gateway connection handshake timed out')
          error.code = 'handshake_timeout'
          this.emit('error', error)
          socket.close?.(1008, 'handshake timeout')
          settleReject(error)
        }
      }, this.handshakeTimeoutMs)
      handshakeTimer.unref?.()
      this._handshakeTimer = handshakeTimer
      socket.on?.('close', () => {
        clearTimeout(handshakeTimer)
        if (!settled) settleReject(new Error('cloud gateway closed before connection.ready'))
      })
      socket.addEventListener?.('close', () => {
        clearTimeout(handshakeTimer)
        if (!settled) settleReject(new Error('cloud gateway closed before connection.ready'))
      })
    })
    try { return await this.connectPromise } finally {
      this.connectPromise = null
      this._connectResolve = null
      this._connectReject = null
      clearTimeout(this._handshakeTimer)
      this._handshakeTimer = null
    }
  }

  start() { return this.connect().catch(() => this.scheduleReconnect()) }

  stop() {
    this.stopped = true
    this.ready = false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    clearInterval(this.heartbeatTimer)
    this.socket?.close?.()
  }

  send(envelope) {
    if (!this.socket || (this.socket.readyState !== undefined && this.socket.readyState !== 1)) throw new Error('cloud gateway is not connected')
    if (!this.ready && envelope?.type !== 'connection.hello') throw new Error('cloud gateway is not authenticated')
    this.socket.send(JSON.stringify(envelope))
  }

  requestReplay(afterCursor = this.lastCursor) {
    this.send({ protocolVersion: '0.1', type: 'gateway.replay.request', payload: { afterCursor } })
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > this.heartbeatMs * 2) {
        this.socket?.close?.(1001, 'heartbeat timeout')
        return
      }
      try { this.send({ protocolVersion: '0.1', type: 'connection.ping', payload: { clientTime: Date.now() } }) } catch {}
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  handleMessage(raw) {
    let envelope
    try { envelope = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : String(raw)) } catch (error) { return this.emit('protocol_error', error) }
    const validation = validateEnvelope(envelope)
    if (!validation.valid) return this.emit('protocol_error', new Error(validation.errors.join(', ')))
    if (envelope.type === 'connection.ready') {
      this.retryCount = 0
      this.ready = true
      clearTimeout(this._handshakeTimer)
      this._connectResolve?.()
      this.emit('ready', envelope)
    }
    if (envelope.type === 'connection.pong') this.lastPongAt = Date.now()
    if (envelope.type === 'connection.close') this.socket?.close?.()
    if (envelope.type === 'channel.message.inbound') this.emit('inbound', envelope)
    if (envelope.type === 'channel.message.status' || envelope.type === 'channel.message.accepted') this.emit('status', envelope)
    if (envelope.type === 'gateway.config.applied') this.emit('config_applied', envelope)
    if (envelope.type === 'gateway.replay.completed') this.lastCursor = Math.max(this.lastCursor, Number(envelope.payload?.cursor || 0))
    if (envelope.type === 'gateway.dead_letter') this.emit('dead_letter', envelope)
    if (envelope.type === 'gateway.error') this.emit('gateway_error', envelope)
    this.emit('message', envelope)
  }

  handleClose() {
    this.ready = false
    clearInterval(this.heartbeatTimer)
    this.emit('disconnected')
    if (!this.stopped) this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(this.reconnectBaseMs * (2 ** this.retryCount), this.reconnectMaxMs)
    this.retryCount += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => this.scheduleReconnect())
    }, delay)
    this.reconnectTimer.unref?.()
  }
}

module.exports = GatewayLink
