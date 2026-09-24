const http = require('http')
const crypto = require('crypto')
const path = require('path')
const { loadConfig } = require('./config')
const FileEventStore = require('./gateway/fileEventStore')
const MockProvider = require('./gateway/mockProvider')
const GatewayServer = require('./gateway/gatewayServer')
const RuntimeConfigStore = require('./wecom/runtimeConfigStore')
const { createRuntimeConfigCipher } = require('./wecom/runtimeConfigCipher')
const { createRuntimeConfigService } = require('./wecom/runtimeConfigService')
const WecomSyncStateStore = require('./wecom/syncStateStore')
const { createWecomApiClient } = require('./wecom/wecomApiClient')
const { createWecomAdapter } = require('./wecom/wecomAdapter')
const WecomProvider = require('./wecom/wecomProvider')
const logger = require('./logger')

function createStore(config) {
  if (config.storeDriver === 'mysql') {
    const MySqlEventStore = require('./gateway/mysqlEventStore')
    return new MySqlEventStore(config.db)
  }
  return new FileEventStore(config.storePath)
}

function createGateway(options = {}) {
  const config = options.config || loadConfig(options.env)
  const store = options.store || createStore(config)
  const mockProvider = options.provider || new MockProvider(options.providerOptions)
  const runtimeConfigService = options.runtimeConfigService || (
    config.wecomRuntimeConfigKey
      ? createRuntimeConfigService({
          store: new RuntimeConfigStore(config.wecomRuntimeConfigStorePath),
          cipher: createRuntimeConfigCipher({ key: config.wecomRuntimeConfigKey })
        })
      : null
  )
  const wecomApiClient = options.wecomApiClient || createWecomApiClient()
  const syncStateStore = options.syncStateStore || new WecomSyncStateStore(
    config.wecomSyncStateStorePath || path.resolve('./data/wecom-sync-states.json')
  )
  const wecomProvider = runtimeConfigService
    ? new WecomProvider({ runtimeConfigService, apiClient: wecomApiClient })
    : null
  const provider = wecomProvider && !options.provider
    ? {
        send(command) {
          return command?.payload?.channel === 'wecom_kf'
            ? wecomProvider.send(command)
            : mockProvider.send(command)
        }
      }
    : mockProvider
  let server
  const wecomAdapter = runtimeConfigService
    ? createWecomAdapter({
        runtimeConfigService,
        apiClient: wecomApiClient,
        syncStateStore,
        ingestInbound: (payload, eventId) => server.ingestInbound(payload, eventId)
      })
    : null
  server = new GatewayServer({
    config,
    store,
    provider,
    accountResolver: options.accountResolver,
    runtimeConfigService
  })
  return {
    config,
    store,
    provider,
    server,
    runtimeConfigService,
    wecomAdapter,
    wecomApiClient,
    wecomProvider
  }
}

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        const error = new Error('request body is too large')
        error.code = 'payload_too_large'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve(body ? JSON.parse(body) : {})
      } catch {
        const error = new Error('request body must be valid JSON')
        error.code = 'invalid_json'
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function readTextBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        const error = new Error('request body is too large')
        error.code = 'payload_too_large'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function textResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(String(body || ''))
}

function createHealthServer(gateway) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://gateway.local')
    const pathname = requestUrl.pathname
    const wecomCallbackMatch = pathname.match(/^\/webhooks\/wecom\/([^/]+)$/)
    if (wecomCallbackMatch && (req.method === 'GET' || req.method === 'POST')) {
      if (!gateway.wecomAdapter) return textResponse(res, 404, 'not found')
      try {
        const callbackKey = decodeURIComponent(wecomCallbackMatch[1])
        const query = Object.fromEntries(requestUrl.searchParams.entries())
        if (req.method === 'GET') {
          const echo = await gateway.wecomAdapter.verifyCallback({ callbackKey, query })
          return textResponse(res, 200, echo)
        }
        const body = await readTextBody(req)
        const result = await gateway.wecomAdapter.handleCallback({ callbackKey, query, body })
        Promise.resolve(result.processing).catch(error => {
          logger.error('wecom.callback_processing_failed', {
            code: error.code || 'wecom_sync_failed'
          })
        })
        return textResponse(res, result.status || 200, result.body || 'success')
      } catch (error) {
        logger.warn('wecom.callback_rejected', { code: error.code || 'invalid_callback' })
        return textResponse(res, error.code === 'wecom_callback_not_found' ? 404 : 400, 'invalid callback')
      }
    }
    if (req.method === 'GET' && pathname === '/healthz') {
      try {
        return jsonResponse(res, 200, await gateway.server.health())
      } catch (error) {
        return jsonResponse(res, 503, { status: 'unavailable', code: 'store_unavailable', message: error.message })
      }
    }
    if (req.method === 'GET' && pathname === '/metrics') {
      try {
        const metrics = (await gateway.server.health()).metrics || {}
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        return res.end(Object.entries(metrics).map(([key, value]) => `gateway_${key} ${Number(value) || 0}`).join('\n') + '\n')
      } catch (error) {
        return jsonResponse(res, 503, { status: 'unavailable', code: 'store_unavailable', message: error.message })
      }
    }
    const mockEventMatch = pathname.match(/^\/mock\/events\/([^/]+)$/)
    if (req.method === 'GET' && mockEventMatch) {
      if (gateway.config.nodeEnv === 'production' || gateway.config.mockInboundEnabled === false) {
        return jsonResponse(res, 404, { success: false, code: 'not_found' })
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (!safeTokenEqual(token, gateway.config.mockInboundToken || gateway.config.authToken)) {
        return jsonResponse(res, 401, { success: false, code: 'unauthorized' })
      }
      try {
        const eventId = decodeURIComponent(mockEventMatch[1])
        const event = await gateway.store.getEvent(eventId)
        if (!event) return jsonResponse(res, 404, { success: false, code: 'event_not_found' })
        const ackResult = event.ackResult && typeof event.ackResult === 'object'
          ? {
              messageId: event.ackResult.messageId || null,
              conversationId: event.ackResult.conversationId || null,
              duplicate: Boolean(event.ackResult.duplicate),
              reason: event.ackResult.reason || null,
              errorCode: event.ackResult.errorCode || null
            }
          : null
        return jsonResponse(res, 200, {
          success: true,
          data: {
            eventId: event.eventId,
            type: event.type,
            sequence: event.sequence,
            status: event.status,
            deliveryAttempt: event.deliveryAttempt,
            lastAttemptAt: event.lastAttemptAt || null,
            lastError: event.lastError || null,
            ackStatus: event.ackStatus || null,
            ackResult,
            ackAt: event.ackAt || null,
            deadLetterReason: event.deadLetterReason || null,
            deadLetterAt: event.deadLetterAt || null,
            createdAt: event.createdAt || null
          }
        })
      } catch (error) {
        return jsonResponse(res, 400, { success: false, code: 'invalid_event_id', message: error.message })
      }
    }
    if (req.method === 'POST' && pathname === '/mock/inbound') {
      if (gateway.config.nodeEnv === 'production' || gateway.config.mockInboundEnabled === false) {
        return jsonResponse(res, 404, { success: false, code: 'not_found' })
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (!safeTokenEqual(token, gateway.config.mockInboundToken || gateway.config.authToken)) {
        return jsonResponse(res, 401, { success: false, code: 'unauthorized' })
      }
      try {
        const body = await readJsonBody(req)
        if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
          return jsonResponse(res, 400, { success: false, code: 'invalid_payload', message: 'payload must be an object' })
        }
        const eventId = body.eventId || crypto.randomUUID()
        const record = await gateway.server.ingestInbound(body.payload, eventId)
        return jsonResponse(res, 202, {
          success: true,
          data: {
            eventId: record.eventId,
            sequence: record.sequence,
            status: record.status,
            duplicate: Boolean(record.duplicate)
          }
        })
      } catch (error) {
        const status = error.code === 'event_id_conflict' ? 409 : error.code === 'payload_too_large' ? 413 : 400
        return jsonResponse(res, status, { success: false, code: error.code || 'invalid_request', message: error.message })
      }
    }
    res.writeHead(404)
    res.end()
  })
}

if (require.main === module) {
  const gateway = createGateway()
  gateway.server.start()
  const health = createHealthServer(gateway)
  health.listen(Number(process.env.HEALTH_PORT || 8788), gateway.config.host)
  let stopping = false
  const shutdown = async signal => {
    if (stopping) return
    stopping = true
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'gateway.shutdown', signal, at: new Date().toISOString() })}\n`)
    await new Promise(resolve => health.close(resolve))
    await gateway.server.stop()
  }
  process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)))
  process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)))
}

module.exports = { createGateway, createHealthServer, createStore, readTextBody }
