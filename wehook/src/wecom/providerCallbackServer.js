const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')

const { createCallbackCrypto } = require('./callbackCrypto')
const { parseEncryptedEnvelope, readXmlTag } = require('./xmlEnvelope')

const DATA_CALLBACK_PATH = '/wecom/suite/data-callback'
const COMMAND_CALLBACK_PATH = '/wecom/suite/command-callback'
const MAX_CALLBACK_BYTES = 256 * 1024

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

function json(res, status, body) {
  text(res, status, JSON.stringify(body), 'application/json; charset=utf-8')
}

function htmlPage(title, description) {
  const escapedTitle = String(title).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value])
  const escapedDescription = String(description).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value])
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>body{margin:0;background:#f5f7fb;color:#162033;font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}.card{max-width:680px;margin:12vh auto;padding:40px;border:1px solid #dce3ee;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgba(22,32,51,.08)}h1{margin:0 0 12px;font-size:28px}p{margin:0;color:#607089}</style></head><body><main class="card"><h1>${escapedTitle}</h1><p>${escapedDescription}</p></main></body></html>`
}

function readBody(req, limit = MAX_CALLBACK_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('callback body is too large'), { code: 'payload_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isWecomId(value) {
  return /^w[wx][A-Za-z0-9_-]{3,127}$/.test(String(value || ''))
}

function optionalTag(xml, tag) {
  return readXmlTag(xml, tag, { required: false, maxBytes: MAX_CALLBACK_BYTES })
}

function parseCommandMetadata(xml) {
  return {
    infoType: optionalTag(xml, 'InfoType'),
    suiteId: optionalTag(xml, 'SuiteId') || optionalTag(xml, 'ToUserName'),
    authCorpId: optionalTag(xml, 'AuthCorpId'),
    changeType: optionalTag(xml, 'ChangeType'),
    timestamp: optionalTag(xml, 'TimeStamp') || optionalTag(xml, 'CreateTime'),
    suiteTicket: optionalTag(xml, 'SuiteTicket'),
    authCode: optionalTag(xml, 'AuthCode')
  }
}

function parseDataEvent(xml, corpId) {
  return {
    corpId,
    event: optionalTag(xml, 'Event'),
    token: optionalTag(xml, 'Token'),
    openKfId: optionalTag(xml, 'OpenKfId')
  }
}

function createControlPlaneBridge({ url, token, request = fetch } = {}) {
  const endpoint = String(url || '').trim()
  const secret = String(token || '').trim()
  if (!endpoint || !secret) return null
  return {
    async enqueue(payload) {
      const response = await request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error(`control plane bridge returned HTTP ${response.status}`)
    }
  }
}

function createControlPlaneProxy(baseUrl) {
  const value = String(baseUrl || '').trim()
  if (!value) return null
  const target = new URL(value)
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
    throw new Error('control plane proxy must use a local HTTP address')
  }
  return function proxy(req, res, pathname) {
    return new Promise(resolve => {
      const headers = { ...req.headers, host: target.host, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': 'https' }
      delete headers.connection
      const upstream = http.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: pathname,
        headers
      }, response => {
        res.writeHead(response.statusCode || 502, response.headers)
        response.pipe(res)
        response.on('end', resolve)
      })
      upstream.on('error', () => {
        if (!res.headersSent) text(res, 502, 'control plane unavailable')
        else res.end()
        resolve()
      })
      req.pipe(upstream)
    })
  }
}

class ProviderCallbackStore {
  constructor(directory, storageKey) {
    this.directory = path.resolve(directory)
    this.storageKey = decodeStorageKey(storageKey)
    this.eventsPath = path.join(this.directory, 'callback-events.ndjson')
    this.statePath = path.join(this.directory, 'command-state.json')
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(this.directory, 0o700) } catch {}
  }

  encryptSecret(value) {
    if (!value) return null
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.storageKey, iv)
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
    return `v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }

  appendEnvelope(event) {
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(this.eventsPath, 0o600) } catch {}
  }

  updateCommandState(metadata, receivedAt) {
    let current = {}
    try { current = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) } catch {}
    const next = {
      ...current,
      suiteId: metadata.suiteId || current.suiteId || null,
      suiteTicketEncrypted: metadata.suiteTicket ? this.encryptSecret(metadata.suiteTicket) : current.suiteTicketEncrypted || null,
      suiteTicketReceivedAt: metadata.suiteTicket ? receivedAt : current.suiteTicketReceivedAt || null,
      lastInfoType: metadata.infoType || null,
      lastAuthCorpId: metadata.authCorpId || null,
      lastAuthCodeEncrypted: metadata.authCode ? this.encryptSecret(metadata.authCode) : null,
      lastReceivedAt: receivedAt
    }
    const temporary = `${this.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.statePath)
    try { fs.chmodSync(this.statePath, 0o600) } catch {}
  }
}

function decodeStorageKey(value) {
  const textValue = Buffer.isBuffer(value) ? value.toString('base64') : String(value || '').trim()
  const key = /^[0-9a-f]{64}$/i.test(textValue) ? Buffer.from(textValue, 'hex') : Buffer.from(textValue, 'base64')
  if (key.length !== 32) throw new Error('provider storage key must decode to exactly 32 bytes')
  return key
}

function createProviderCallbackServer(options = {}) {
  const token = String(options.token || '').trim()
  const encodingAesKey = String(options.encodingAesKey || '').trim()
  const suiteId = String(options.suiteId || '').trim()
  const providerCorpId = String(options.providerCorpId || '').trim()
  if (!token) throw new Error('provider callback token is required')
  if (!encodingAesKey) throw new Error('provider callback EncodingAESKey is required')
  if (suiteId && !isWecomId(suiteId)) throw new Error('provider suiteId is invalid')
  if (providerCorpId && !isWecomId(providerCorpId)) throw new Error('provider corpId is invalid')
  const store = options.store || new ProviderCallbackStore(options.storeDirectory || './data/provider-callback', options.storageKey)
  const verificationDirectory = options.verificationDirectory ? path.resolve(options.verificationDirectory) : null
  const now = options.now || (() => new Date().toISOString())
  const logger = options.logger || {
    info(event) { process.stdout.write(`${JSON.stringify({ level: 'info', ...event })}\n`) },
    warn(event) { process.stderr.write(`${JSON.stringify({ level: 'warn', ...event })}\n`) }
  }
  const eventBridge = options.eventBridge || null
  const controlPlaneProxy = options.controlPlaneProxy || null

  function cryptoFor(kind, requestUrl, envelope = '', verification = false) {
    let receiveId = suiteId
    if (kind === 'data') {
      receiveId = requestUrl.searchParams.get('corpid') || optionalTag(envelope, 'ToUserName')
    } else if (verification) {
      receiveId = providerCorpId
    }
    if (!isWecomId(receiveId)) {
      const error = new Error(kind === 'command' ? (verification ? 'provider corp id is not configured' : 'suite id is not configured') : 'callback corp id is invalid')
      error.code = kind === 'command' ? (verification ? 'provider_corp_id_missing' : 'suite_id_missing') : 'corp_id_invalid'
      throw error
    }
    return { receiveId, callbackCrypto: createCallbackCrypto({ token, encodingAesKey, receiveId }) }
  }

  async function handleVerification(req, res, kind, requestUrl) {
    const { callbackCrypto } = cryptoFor(kind, requestUrl, '', true)
    const echo = callbackCrypto.decrypt({
      signature: requestUrl.searchParams.get('msg_signature'),
      timestamp: requestUrl.searchParams.get('timestamp'),
      nonce: requestUrl.searchParams.get('nonce'),
      encrypted: requestUrl.searchParams.get('echostr')
    })
    logger.info({ event: 'wecom.provider_verification_ok', kind, at: now() })
    return text(res, 200, echo)
  }

  async function handleNotification(req, res, kind, requestUrl) {
    const envelope = await readBody(req)
    const { encrypted } = parseEncryptedEnvelope(envelope, { maxBytes: MAX_CALLBACK_BYTES })
    const { receiveId, callbackCrypto } = cryptoFor(kind, requestUrl, envelope)
    const cleartext = callbackCrypto.decrypt({
      signature: requestUrl.searchParams.get('msg_signature'),
      timestamp: requestUrl.searchParams.get('timestamp'),
      nonce: requestUrl.searchParams.get('nonce'),
      encrypted
    })
    const receivedAt = now()
    const eventId = crypto.createHash('sha256').update(`${kind}\0${encrypted}`).digest('hex')
    store.appendEnvelope({ eventId, kind, receiveId, receivedAt, encrypted })
    const commandMetadata = kind === 'command' ? parseCommandMetadata(cleartext) : null
    if (commandMetadata) store.updateCommandState(commandMetadata, receivedAt)
    const bridgePayload = kind === 'command'
      ? { kind, metadata: commandMetadata }
      : { kind, event: parseDataEvent(cleartext, receiveId) }
    if (eventBridge) {
      setImmediate(() => eventBridge.enqueue(bridgePayload).catch(error => logger.warn({ event: 'wecom.provider_bridge_failed', kind, reason: error.code || error.message || 'bridge_failed', at: now() })))
    }
    logger.info({ event: 'wecom.provider_notification_ok', kind, infoType: commandMetadata?.infoType || null, eventId, at: receivedAt })
    return text(res, 200, 'success')
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://provider.local')
    const kind = requestUrl.pathname === DATA_CALLBACK_PATH ? 'data' : requestUrl.pathname === COMMAND_CALLBACK_PATH ? 'command' : null
    try {
      if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
        return json(res, 200, { status: 'ok', service: 'lonely-warrior-wecom-provider', commandCallbackConfigured: Boolean(suiteId && providerCorpId) })
      }
      const verificationMatch = requestUrl.pathname.match(/^\/(WW_verify_[A-Za-z0-9]+\.txt)$/)
      if (req.method === 'GET' && verificationMatch && verificationDirectory) {
        const verificationPath = path.join(verificationDirectory, verificationMatch[1])
        try {
          const body = fs.readFileSync(verificationPath)
          return text(res, 200, body)
        } catch (error) {
          if (error.code === 'ENOENT') return text(res, 404, 'not found')
          throw error
        }
      }
      if (req.method === 'GET' && requestUrl.pathname === '/') {
        return text(res, 200, htmlPage('孤勇者企业微信服务', '企业微信服务商应用接入服务运行正常。'), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && requestUrl.pathname === '/wecom/app') {
        return text(res, 200, htmlPage('孤勇者客服工作台', '应用正在配置中，完成企业授权后即可使用。'), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && requestUrl.pathname === '/wecom/settings') {
        return text(res, 200, htmlPage('企业微信应用设置', '企业管理员设置入口正在配置中。'), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && requestUrl.pathname === '/wecom/install/complete') {
        const authCode = requestUrl.searchParams.get('auth_code')
        const state = requestUrl.searchParams.get('state')
        if (!authCode || !state || !eventBridge) return text(res, 400, htmlPage('安装未完成', '授权结果不完整，请回到运营后台重新生成安装链接。'), 'text/html; charset=utf-8')
        await eventBridge.enqueue({ kind: 'install_complete', metadata: { infoType: 'create_auth', authCode, state } })
        return text(res, 200, htmlPage('企业授权已接收', '可以关闭本页，回到孤勇者运营后台继续绑定客户租户。'), 'text/html; charset=utf-8')
      }
      if (controlPlaneProxy && (requestUrl.pathname === '/console' || requestUrl.pathname === '/console/')) {
        return await controlPlaneProxy(req, res, '/?surface=admin')
      }
      if (controlPlaneProxy && (requestUrl.pathname.startsWith('/assets/') || requestUrl.pathname.startsWith('/v1/'))) {
        return await controlPlaneProxy(req, res, `${requestUrl.pathname}${requestUrl.search}`)
      }
      if (kind && req.method === 'GET') return await handleVerification(req, res, kind, requestUrl)
      if (kind && req.method === 'POST') return await handleNotification(req, res, kind, requestUrl)
      return text(res, 404, 'not found')
    } catch (error) {
      logger.warn({
        event: 'wecom.provider_callback_rejected',
        method: req.method,
        path: requestUrl.pathname,
        reason: error.code || error.message || 'invalid_callback',
        at: now()
      })
      if (error.code === 'suite_id_missing' || error.code === 'provider_corp_id_missing') return text(res, 503, 'command callback identity is not configured')
      if (error.code === 'payload_too_large') return text(res, 413, 'payload too large')
      return text(res, 400, 'invalid callback')
    }
  })

  return { server, store }
}

function startProviderCallbackServer(options = {}) {
  const env = options.env || process.env
  const instance = createProviderCallbackServer({
    token: env.WECOM_PROVIDER_TOKEN,
    encodingAesKey: env.WECOM_PROVIDER_AES_KEY,
    suiteId: env.WECOM_PROVIDER_SUITE_ID,
    providerCorpId: env.WECOM_PROVIDER_CORP_ID,
    storageKey: env.WECOM_PROVIDER_STORE_KEY,
    storeDirectory: env.WECOM_PROVIDER_STORE_DIR || './data/provider-callback',
    verificationDirectory: env.WECOM_PROVIDER_VERIFICATION_DIR
    ,eventBridge: createControlPlaneBridge({ url: env.WECOM_CONTROL_PLANE_EVENTS_URL, token: env.WECOM_CONTROL_PLANE_INTERNAL_TOKEN })
    ,controlPlaneProxy: createControlPlaneProxy(env.WECOM_CONTROL_PLANE_PROXY_URL)
  })
  const host = env.WECOM_PROVIDER_HOST || '127.0.0.1'
  const port = Number.parseInt(env.WECOM_PROVIDER_PORT || '8791', 10)
  instance.server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({ event: 'wecom.provider_ready', host, port })}\n`)
  })
  return instance
}

if (require.main === module) startProviderCallbackServer()

module.exports = {
  COMMAND_CALLBACK_PATH,
  DATA_CALLBACK_PATH,
  ProviderCallbackStore,
  createProviderCallbackServer,
  createControlPlaneBridge,
  createControlPlaneProxy,
  decodeStorageKey,
  parseDataEvent,
  parseCommandMetadata,
  startProviderCallbackServer
}
