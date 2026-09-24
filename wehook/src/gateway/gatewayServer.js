const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const { createEnvelope, createRuntimeConfigApplied, validateEnvelope } = require('../protocol')
const CommandService = require('./commandService')
const logger = require('../logger')

function loadWs() {
  try { return require('ws') } catch (error) {
    throw new Error('WSS requires the optional `ws` dependency. Run npm install before starting the gateway.')
  }
}

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function isPromise(value) { return Boolean(value && typeof value.then === 'function') }

class GatewayServer {
  constructor({ config, store, provider, accountResolver, runtimeConfigService }) {
    this.config = config
    this.store = store
    this.provider = provider
    this.accountResolver = accountResolver || (() => true)
    this.runtimeConfigService = runtimeConfigService || null
    this.clients = new Set()
    this.pendingTimers = new Map()
    this.authTimers = new Map()
    this.deliveryLocks = new Map()
    this.server = null
    this.tlsServer = null
    this.startedAt = null
    this.monitorTimer = null
    this.commandService = new CommandService({
      store,
      provider,
      publish: envelope => this.publishEvent(envelope)
    })
  }

  start() {
    if (this.server) return this.server
    const WebSocket = loadWs()
    if (this.config.tlsCertPath && this.config.tlsKeyPath) {
      this.tlsServer = https.createServer({
        cert: fs.readFileSync(this.config.tlsCertPath),
        key: fs.readFileSync(this.config.tlsKeyPath)
      })
      this.server = new WebSocket.Server({ server: this.tlsServer })
      this.tlsServer.listen(this.config.port, this.config.host)
    } else {
      this.server = new WebSocket.Server({ host: this.config.host, port: this.config.port })
    }
    this.server.on('connection', socket => this.attachSocket(socket))
    this.server.on('listening', () => {
      this.startedAt = new Date().toISOString()
      logger.info('gateway.wss_listening', { host: this.config.host, port: this.config.port })
    })
    this.monitorTimer = setInterval(() => {
      const cutoff = Date.now() - this.config.heartbeatMs * 3
      for (const client of this.clients) {
        if (client.authenticated && client.lastPongAt < cutoff) client.socket.close?.(1001, 'heartbeat timeout')
      }
    }, this.config.heartbeatMs)
    this.monitorTimer.unref?.()
    return this.server
  }

  stop() {
    for (const client of this.clients) {
      clearTimeout(this.authTimers.get(client))
      client.socket.close?.()
    }
    for (const timer of this.pendingTimers.values()) clearTimeout(timer.timeout || timer)
    this.pendingTimers.clear()
    this.authTimers.clear()
    this.deliveryLocks.clear()
    this.clients.clear()
    clearInterval(this.monitorTimer)
    if (this.server) this.server.close()
    if (this.tlsServer) this.tlsServer.close()
    this.server = null
    this.tlsServer = null
    return this.store.close?.()
  }

  attachSocket(socket) {
    const client = { socket, authenticated: false, clientId: null, lastPongAt: Date.now(), cursor: 0, closed: false }
    this.clients.add(client)
    const authTimer = setTimeout(() => {
      if (!client.authenticated) {
        this.send(client, createEnvelope('gateway.error', { code: 'authentication_timeout', message: 'Send connection.hello first' }, { eventId: crypto.randomUUID() }))
        socket.close?.(1008, 'authentication timeout')
      }
    }, this.config.authTimeoutMs || 5000)
    authTimer.unref?.()
    this.authTimers.set(client, authTimer)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : String(raw)) } catch {
        return this.send(client, createEnvelope('gateway.error', { code: 'invalid_json', message: 'Invalid JSON' }, { eventId: crypto.randomUUID() }))
      }
      this.handleMessage(client, message).catch(error => {
        logger.error('gateway.message_failed', { error: error.message, type: message.type })
        this.send(client, createEnvelope('gateway.error', { code: error.code || 'internal_error', message: error.message }, { eventId: crypto.randomUUID() }))
      })
    }
    socket.on?.('message', onMessage)
    const cleanup = () => {
      client.closed = true
      clearTimeout(this.authTimers.get(client))
      this.authTimers.delete(client)
      for (const [eventId, timer] of this.pendingTimers.entries()) {
        if (timer.client === client) {
          clearTimeout(timer.timeout)
          this.pendingTimers.delete(eventId)
        }
      }
      this.clients.delete(client)
    }
    socket.on?.('close', cleanup)
    socket.on?.('error', cleanup)
    return client
  }

  async handleMessage(client, message) {
    if (message.type === 'connection.hello') return this.handleHello(client, message)
    if (!client.authenticated) return this.send(client, createEnvelope('gateway.error', { code: 'unauthorized', message: 'Authenticate first' }, { eventId: crypto.randomUUID() }))
    const validation = validateEnvelope(message, { requireCommandId: message.type === 'channel.message.send' })
    if (!validation.valid) return this.send(client, createEnvelope('gateway.error', { code: 'invalid_envelope', errors: validation.errors }, { eventId: crypto.randomUUID() }))
    if (message.type === 'gateway.config.apply') return this.handleRuntimeConfigApply(client, message)
    if (message.type === 'connection.ping') {
      client.lastPongAt = Date.now()
      return this.send(client, createEnvelope('connection.pong', { serverTime: Date.now() }, { eventId: crypto.randomUUID() }))
    }
    if (message.type === 'gateway.event.ack') {
      const status = message.status || message.payload?.status
      const acked = await this.store.acknowledge(message.ackForEventId, status, message.result || message.payload?.result)
      if (!acked) {
        return this.send(client, createEnvelope('gateway.error', { code: 'unknown_ack_target', ackForEventId: message.ackForEventId }, { eventId: crypto.randomUUID() }))
      }
      const timer = this.pendingTimers.get(message.ackForEventId)
      if (timer && timer.client === client) {
        clearTimeout(timer.timeout)
        this.pendingTimers.delete(message.ackForEventId)
      }
      if (acked?.status && acked.status !== 'pending') client.cursor = Math.max(client.cursor, acked.sequence || 0)
      if (status === 'rejected') {
        const reason = message.result?.reason || message.payload?.result?.reason || 'event rejected by Rag'
        await this.store.deadLetter(message.ackForEventId, reason)
        this.send(client, createEnvelope('gateway.dead_letter', { eventId: message.ackForEventId, reason }, { eventId: crypto.randomUUID() }))
      }
      if (status === 'retryable_error') {
        const event = await this.store.getEvent(message.ackForEventId)
        if (event) this.scheduleDelivery(client, event, this.config.retryBaseMs || 500)
      }
      return
    }
    if (message.type === 'channel.message.send') {
      const existing = await this.store.getCommand(message.commandId)
      const result = await this.commandService.handle(message)
      if (existing) {
        const type = result.status === 'accepted' ? 'channel.message.accepted' : 'channel.message.status'
        const prefix = type === 'channel.message.accepted' ? 'accepted' : 'status'
        const storedEvent = await this.store.getEvent(prefix + '-' + result.commandId + '-' + result.status)
        // 已 ACK 的命令结果不再属于 pending Outbox，但重复 commandId 仍需立即
        // 向请求连接回放最终结果，避免 Rag 等待一个不会再次广播的状态。
        if (storedEvent?.status && storedEvent.status !== 'pending') {
          this.send(client, { ...createEnvelope(type, result, { eventId: storedEvent.eventId }), replayed: true })
        }
      }
      return result
    }
    if (message.type === 'gateway.replay.request') {
      const afterCursor = Number(message.payload?.afterCursor || 0)
      if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
        return this.send(client, createEnvelope('gateway.error', { code: 'invalid_cursor', message: 'afterCursor must be a non-negative integer' }, { eventId: crypto.randomUUID() }))
      }
      return this.replay(client, afterCursor)
    }
    if (message.type === 'connection.close') return client.socket.close?.()
  }

  async handleRuntimeConfigApply(client, message) {
    const payload = message.payload || {}
    try {
      if (!this.runtimeConfigService) {
        const error = new Error('runtime config service is not configured')
        error.code = 'config_service_unavailable'
        throw error
      }
      const applied = await this.runtimeConfigService.apply(payload)
      return this.send(client, createRuntimeConfigApplied({
        requestId: payload.requestId,
        connectionId: applied.connectionId,
        configVersion: applied.configVersion,
        status: 'applied',
        duplicate: Boolean(applied.duplicate)
      }))
    } catch (error) {
      return this.send(client, createRuntimeConfigApplied({
        requestId: payload.requestId,
        connectionId: Number(payload.connectionId),
        configVersion: Number(payload.configVersion),
        status: 'rejected',
        errorCode: error.code || 'config_apply_failed'
      }))
    }
  }

  async handleHello(client, message) {
    if (message.protocolVersion !== '0.1') {
      this.send(client, createEnvelope('gateway.error', { code: 'unsupported_protocol', message: 'Unsupported protocolVersion' }, { eventId: crypto.randomUUID() }))
      client.socket.close?.(1002, 'unsupported protocol')
      return
    }
    if (!message.payload || typeof message.payload !== 'object' || !String(message.payload.clientId || '').trim()) {
      this.send(client, createEnvelope('gateway.error', { code: 'invalid_hello', message: 'clientId is required' }, { eventId: crypto.randomUUID() }))
      client.socket.close?.(1008, 'invalid hello')
      return
    }
    const token = message.payload?.authToken || message.authToken
    if (!safeTokenEqual(token, this.config.authToken)) {
      this.send(client, createEnvelope('gateway.error', { code: 'unauthorized', message: 'Authentication failed' }, { eventId: crypto.randomUUID() }))
      client.socket.close?.(1008, 'unauthorized')
      return
    }
    clearTimeout(this.authTimers.get(client))
    this.authTimers.delete(client)
    for (const existing of this.clients) {
      if (existing !== client && existing.authenticated && existing.clientId === (message.payload?.clientId || 'rag-server')) {
        existing.socket.close?.(1008, 'replaced by a newer authenticated connection')
      }
    }
    client.authenticated = true
    client.clientId = message.payload?.clientId || 'rag-server'
    const lastCursor = Number(message.payload?.lastCursor || 0)
    if (!Number.isSafeInteger(lastCursor) || lastCursor < 0) {
      this.send(client, createEnvelope('gateway.error', { code: 'invalid_cursor', message: 'lastCursor must be a non-negative integer' }, { eventId: crypto.randomUUID() }))
      client.socket.close?.(1008, 'invalid cursor')
      return
    }
    client.cursor = lastCursor
    this.send(client, createEnvelope('connection.ready', { protocolVersion: '0.1', serverTime: Date.now(), replayFrom: client.cursor }, { eventId: crypto.randomUUID() }))
    return this.replay(client, client.cursor)
  }

  async replay(client, afterCursor = 0) {
    if (!client.authenticated) return
    const pending = await this.store.listPending({ afterCursor, limit: Number.MAX_SAFE_INTEGER })
    for (const event of pending) await this.deliver(client, event)
    const deadLetters = await this.store.listDeadLetters({ afterCursor, limit: Number.MAX_SAFE_INTEGER })
    for (const deadLetter of deadLetters) {
      this.send(client, createEnvelope('gateway.dead_letter', deadLetter, { eventId: 'dead-letter-' + deadLetter.eventId }))
    }
    this.send(client, createEnvelope('gateway.replay.completed', { afterCursor, cursor: await this.store.getCursor() }, { eventId: crypto.randomUUID() }))
  }

  async deliver(client, event) {
    if (!client.authenticated || client.closed || !event || event.status !== 'pending') return null
    const lockKey = `${client.clientId || 'anonymous'}:${event.eventId}`
    if (this.deliveryLocks.has(lockKey)) return this.deliveryLocks.get(lockKey)
    const operation = this._deliver(client, event)
    this.deliveryLocks.set(lockKey, operation)
    try { return await operation } finally { this.deliveryLocks.delete(lockKey) }
  }

  async _deliver(client, event) {
    if (event.deliveryAttempt >= this.config.maxRetries) {
      await this.store.deadLetter(event.eventId, 'maximum delivery attempts exceeded')
      this.send(client, createEnvelope('gateway.dead_letter', { eventId: event.eventId, reason: 'maximum delivery attempts exceeded' }, { eventId: crypto.randomUUID() }))
      return this.store.getEvent(event.eventId)
    }
    const nextAttempt = event.deliveryAttempt + 1
    const sent = this.send(client, { ...event, deliveryAttempt: nextAttempt, replayed: nextAttempt > 1 })
    if (!sent) return event
    const updated = await this.store.markAttempt(event.eventId, { replayed: event.deliveryAttempt > 0, clientId: client.clientId })
    if (!updated) return this.store.getEvent(event.eventId)
    this.scheduleDelivery(client, updated)
    return updated
  }

  scheduleDelivery(client, event, baseDelayMs = this.config.ackTimeoutMs) {
    const previous = this.pendingTimers.get(event.eventId)
    if (previous) clearTimeout(previous.timeout)
    const delay = Math.min(
      baseDelayMs * (2 ** Math.max(0, event.deliveryAttempt - 1)),
      this.config.retryMaxMs || 30000
    )
    const timeout = setTimeout(async () => {
      this.pendingTimers.delete(event.eventId)
      const current = await this.store.getEvent(event.eventId)
      if (current?.status === 'pending' && client.authenticated && !client.closed) this.deliver(client, current).catch(() => {})
    }, delay)
    timeout.unref?.()
    this.pendingTimers.set(event.eventId, { timeout, client })
  }

  ingestInbound(payload, eventId = crypto.randomUUID()) {
    const envelope = createEnvelope('channel.message.inbound', payload, { eventId })
    const required = ['channel', 'accountId', 'channelUserId', 'messageType', 'content']
    const invalid = required.filter(field => payload?.[field] === undefined || payload?.[field] === null)
    const invalidReason = invalid.length
      ? `invalid inbound payload: ${invalid.join(',')}`
      : (!this.accountResolver(payload.accountId, payload) ? 'unknown accountId' : null)
    const appended = this.store.appendEvent(envelope)
    if (isPromise(appended)) return appended.then(record => this._finalizeInbound(record, eventId, invalidReason))
    return this._finalizeInbound(appended, eventId, invalidReason)
  }

  _finalizeInbound(record, eventId, invalidReason) {
    if (invalidReason) {
      if (!record.duplicate) {
        const deadLettered = this.store.deadLetter(eventId, invalidReason)
        if (isPromise(deadLettered)) return deadLettered.then(value => value || record)
      }
      const stored = this.store.getEvent(eventId)
      if (isPromise(stored)) return stored.then(value => value || record)
      return stored || record
    }
    if (!record.duplicate || record.status === 'pending') {
      for (const client of this.clients) if (client.authenticated) this.deliver(client, record).catch(() => {})
    }
    return record
  }

  async retryPending() {
    const deliveries = []
    const pending = await this.store.listPending({ afterCursor: 0, limit: Number.MAX_SAFE_INTEGER })
    for (const event of pending) {
      for (const client of this.clients) if (client.authenticated) deliveries.push(this.deliver(client, event))
    }
    return Promise.all(deliveries)
  }

  broadcast(envelope) {
    for (const client of this.clients) if (client.authenticated) this.send(client, envelope)
  }

  publishEvent(envelope) {
    const appended = this.store.appendEvent(envelope)
    if (isPromise(appended)) return appended.then(record => this._deliverPublishedEvent(record))
    return this._deliverPublishedEvent(appended)
  }

  _deliverPublishedEvent(record) {
    if (!record.duplicate || record.status === 'pending') {
      for (const client of this.clients) if (client.authenticated) this.deliver(client, record).catch(() => {})
    }
    return record
  }

  send(client, envelope) {
    if (!client?.socket || client.closed || client.socket.readyState === 3) return false
    try {
      client.socket.send(JSON.stringify(envelope))
      return true
    } catch (error) {
      logger.warn('gateway.socket_send_failed', { error: error.message })
      return false
    }
  }

  health() {
    const cursor = this.store.getCursor()
    const metrics = this.store.stats()
    const build = ([resolvedCursor, resolvedMetrics]) => ({
      status: 'ok',
      startedAt: this.startedAt,
      storeDriver: this.config.storeDriver || 'file',
      authenticatedClients: [...this.clients].filter(client => client.authenticated).length,
      cursor: resolvedCursor,
      metrics: resolvedMetrics
    })
    if (isPromise(cursor) || isPromise(metrics)) return Promise.all([cursor, metrics]).then(build)
    return build([cursor, metrics])
  }
}

module.exports = GatewayServer
