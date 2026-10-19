const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { FileSaasStore } = require('./fileSaasStore')
const { TokenLedger } = require('./tokenLedger')
const { ModelBilling } = require('./modelBilling')
const ControlPlaneService = require('./controlPlaneService')
const CloudMessagingService = require('./cloudMessagingService')
const { createSecretCipher } = require('./secretCipher')
const { createOpenAiCompatibleClient } = require('./openAiCompatibleClient')
const WecomSuiteService = require('./wecomSuiteService')
const WechatShopService = require('./wechatShopService')
const { ShopCustomerOrders } = require('./shopCustomerOrders')
const { LocalWorkbenchPairing } = require('./localWorkbenchPairing')
const { createWechatShopClient } = require('./wechatShopClient')
const { createWecomSuiteClient } = require('../wecom/wecomSuiteClient')
const { signSession, verifySession } = require('./security')

const PUBLIC_DIR = path.resolve(__dirname, '../../cloud-console/public')
const COOKIE_NAME = 'lw_session'

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': type.includes('html') ? 'no-store' : 'no-cache' })
  res.end(body)
}

function binary(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) return reject(Object.assign(new Error('request is too large'), { code: 'payload_too_large' }))
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(Object.assign(new Error('request body must be valid JSON'), { code: 'invalid_json' })) }
    })
    req.on('error', reject)
  })
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=')
    return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))]
  }))
}

function requestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().split(':')[0]
}

function surfaceFor(req, fallback = '') {
  const host = requestHost(req)
  if (host.startsWith('admin.')) return 'admin'
  if (host.startsWith('account.')) return 'account'
  if (host.startsWith('api.')) return 'api'
  return fallback
}

function parseSession(req, secret) {
  return verifySession(cookies(req)[COOKIE_NAME], secret)
}

function sessionCookie(value, maxAge = 8 * 60 * 60) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

function requireRole(req, res, secret, role) {
  const session = parseSession(req, secret)
  if (!session) {
    json(res, 401, { success: false, code: 'unauthorized', message: '请重新登录' })
    return null
  }
  if (session.role !== role) {
    json(res, 403, { success: false, code: 'forbidden', message: '当前账户无权执行此操作' })
    return null
  }
  if (session.mustChangePassword) {
    json(res, 428, { success: false, code: 'password_change_required', message: '首次登录必须先修改密码' })
    return null
  }
  return session
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  try { return new URL(origin).host.split(':')[0] === requestHost(req) } catch { return false }
}

function secureTokenEqual(left, right) {
  if (!left || !right) return false
  const a = crypto.createHash('sha256').update(String(left)).digest()
  const b = crypto.createHash('sha256').update(String(right)).digest()
  return crypto.timingSafeEqual(a, b)
}

function publicError(error) {
  if (error.code === 'local_shop_owned') return { code: error.code, message: error.message }
  if (['shop_order_invalid', 'shop_order_unrelated', 'customer_invalid_profile', 'customer_profile_conflict'].includes(error.code)) return { code: error.code, message: error.message }
  const shopCodes = new Set(['shop_invalid_config', 'shop_not_found', 'shop_not_ready', 'shop_conflict', 'shop_api_error', 'shop_transport_error', 'shop_reply_limit', 'shop_callback_rejected', 'shop_media_invalid', 'shop_media_missing', 'shop_media_too_large'])
  if (shopCodes.has(error.code)) return { code: error.code, message: error.message }
  const known = new Set(['invalid_json', 'payload_too_large', 'invalid_tenant', 'tenant_conflict', 'username_conflict', 'weak_password', 'invalid_current_password', 'password_unchanged', 'tenant_not_found', 'invalid_corp_id', 'corp_id_conflict', 'invalid_credits', 'insufficient_credits', 'idempotency_key_required', 'reservation_not_found', 'reservation_not_active', 'invalid_model_base_url', 'model_api_key_required', 'model_name_required', 'model_http_error', 'model_api_error', 'model_timeout', 'model_empty_response', 'wecom_not_ready', 'wecom_suite_not_ready', 'wecom_install_state_invalid', 'wecom_install_redirect_invalid', 'wecom_installation_not_found', 'invalid_inbound_message', 'conversation_not_found', 'reply_required', 'wecom_media_missing', 'wecom_media_invalid', 'wecom_media_too_large'])
  return { code: known.has(error.code) ? error.code : 'invalid_request', message: known.has(error.code) ? error.message : '请求未能完成，请检查输入后重试' }
}

function createRateLimiter({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map()
  return {
    allow(key) {
      const now = Date.now()
      const current = attempts.get(key)
      if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      current.count += 1
      return current.count <= max
    },
    clear(key) { attempts.delete(key) }
  }
}

function createControlPlane(options = {}) {
  const env = options.env || process.env
  const store = options.store || new FileSaasStore(env.CONTROL_PLANE_STORE_PATH || './data/control-plane.json')
  const ledger = options.ledger || new TokenLedger(store)
  const service = options.service || new ControlPlaneService(store, ledger)
  const sessionSecret = env.CONTROL_PLANE_SESSION_SECRET
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('CONTROL_PLANE_SESSION_SECRET must contain at least 32 characters')
  const adminPassword = env.CONTROL_PLANE_ADMIN_PASSWORD
  if (!adminPassword || adminPassword.length < 8) throw new Error('CONTROL_PLANE_ADMIN_PASSWORD must contain at least 8 characters; first sign-in requires a 12-character replacement')
  const adminUsername = env.CONTROL_PLANE_ADMIN_USERNAME || 'admin'
  const dataKey = env.CONTROL_PLANE_DATA_KEY || crypto.createHash('sha256').update(`control-plane-data:${sessionSecret}`).digest('base64')
  const cipher = options.cipher || createSecretCipher(dataKey)
  const modelClient = options.modelClient || createOpenAiCompatibleClient({ allowInsecure: env.NODE_ENV === 'test' })
  const messaging = options.messaging || new CloudMessagingService({ store, cipher, modelClient, wecomSender: options.wecomSender })
  const billing = new ModelBilling({ store, messaging, modelClient })
  messaging.billing = billing
  const wecomSuite = options.wecomSuite || new WecomSuiteService({ store, cipher, client: options.wecomSuiteClient || createWecomSuiteClient(), messaging, suiteId: env.WECOM_PROVIDER_SUITE_ID, suiteSecret: env.WECOM_PROVIDER_SUITE_SECRET, installAuthType: env.WECOM_INSTALL_AUTH_TYPE })
  if (!options.wecomSender) messaging.wecomSender = wecomSuite.sender()
  const wechatShop = new WechatShopService({ store, cipher, messaging, client: options.wechatShopClient || createWechatShopClient() })
  messaging.shopSender = wechatShop.sender()
  const customerOrders = new ShopCustomerOrders({ store, cipher, shop: wechatShop })
  const localPairing = new LocalWorkbenchPairing({ store })
  const pairingLimiter = createRateLimiter({ max: 10, windowMs: 60 * 1000 })
  const internalToken = String(env.CONTROL_PLANE_INTERNAL_TOKEN || '')
  const loginLimiter = createRateLimiter()
  const ready = service.bootstrap({ adminUsername, adminPassword, adminMustChangePassword: env.CONTROL_PLANE_ADMIN_MUST_CHANGE_PASSWORD !== 'false' })

  async function handler(req, res) {
    await ready
    const url = new URL(req.url, 'http://control-plane.local')
    const pathname = url.pathname
    try {
      if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { status: 'ok', service: 'lonely-warrior-control-plane' })
      if (['/v1/models', '/v1/chat/completions', '/v1/billing/account'].includes(pathname)) {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const identity = await service.authenticateModelKey(token) || await service.authenticateDevice(token)
        if (!identity) return json(res, 401, { error: { message: '设备凭证无效或已撤销', type: 'authentication_error' } })
        if (pathname === '/v1/models' && req.method === 'GET') return json(res, 200, { object: 'list', data: ['customer-auto', 'customer-text', 'customer-vision'].map(id => ({ id, object: 'model', owned_by: 'lonely-warrior' })) })
        if (pathname === '/v1/billing/account' && req.method === 'GET') return json(res, 200, { success: true, data: await billing.wallet(identity.tenantId) })
        if (pathname === '/v1/chat/completions' && req.method === 'POST') {
          const body = await readJson(req, 1024 * 1024)
          let result
          try { result = await billing.complete(identity, body, String(req.headers['idempotency-key'] || crypto.randomUUID())) }
          catch (error) {
            error.billing = await billing.wallet(identity.tenantId)
            res.setHeader('x-model-balance', String(error.billing.balance))
            res.setHeader('x-model-balance-unit', String(error.billing.unit))
            throw error
          }
          res.setHeader('x-model-balance', String(result.billing.balance))
          res.setHeader('x-model-balance-unit', String(result.billing.unit))
          if (!body.stream) return json(res, 200, result)
          // Buffered SSE preserves OpenAI client compatibility; settlement precedes delivery.
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
          const base = { id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model, billing: result.billing }
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: result.choices[0].message.content }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
          if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: result.usage })}\n\n`)
          return res.end('data: [DONE]\n\n')
        }
        return json(res, 405, { error: { message: '请求方法不支持' } })
      }
      const shopCallback = pathname.match(/^\/v1\/shop\/callback\/([a-zA-Z0-9-]+)$/)
      if (shopCallback && req.method === 'GET') return text(res, 200, await wechatShop.verify(shopCallback[1], url.searchParams))
      if (shopCallback && req.method === 'POST') {
        await wechatShop.receive(shopCallback[1], url.searchParams, await readJson(req, 1024 * 1024))
        return text(res, 200, 'success')
      }
      if (req.method === 'GET' && pathname === '/assets/cloud.css') return text(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'assets/cloud.css')), 'text/css; charset=utf-8')
      if (req.method === 'GET' && pathname === '/assets/cloud.js') return text(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'assets/cloud.js')), 'text/javascript; charset=utf-8')
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const surface = surfaceFor(req, url.searchParams.get('surface') || 'account')
        if (surface === 'api') return json(res, 200, { service: 'Lonely Warrior API Gateway', status: 'ready', version: 1 })
        const file = surface === 'admin' ? 'admin.html' : 'account.html'
        return text(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), 'text/html; charset=utf-8')
      }
      if (req.method === 'POST' && pathname === '/v1/auth/login') {
        if (!sameOrigin(req)) return json(res, 403, { success: false, code: 'origin_rejected', message: '请求来源不受信任' })
        const key = `${req.socket.remoteAddress || 'unknown'}:${surfaceFor(req, 'development')}`
        if (!loginLimiter.allow(key)) return json(res, 429, { success: false, code: 'too_many_attempts', message: '尝试次数过多，请稍后再试' })
        const body = await readJson(req)
        const surface = surfaceFor(req, body.surface)
        if (!['admin', 'account'].includes(surface)) return json(res, 400, { success: false, code: 'invalid_surface' })
        const user = await service.authenticate(body.username, body.password, surface)
        if (!user) return json(res, 401, { success: false, code: 'invalid_credentials', message: '用户名或密码不正确' })
        loginLimiter.clear(key)
        const token = signSession(user, sessionSecret)
        return json(res, 200, { success: true, data: { username: user.username, role: user.role, mustChangePassword: user.mustChangePassword } }, { 'set-cookie': sessionCookie(token) })
      }
      if (req.method === 'POST' && pathname === '/v1/auth/password') {
        if (!sameOrigin(req)) return json(res, 403, { success: false, code: 'origin_rejected' })
        const session = parseSession(req, sessionSecret)
        if (!session) return json(res, 401, { success: false, code: 'unauthorized' })
        const user = await service.changePassword({ userId: session.id, ...(await readJson(req)) })
        return json(res, 200, { success: true, data: { username: user.username, role: user.role, mustChangePassword: false } }, { 'set-cookie': sessionCookie(signSession(user, sessionSecret)) })
      }
      if (req.method === 'POST' && pathname === '/v1/auth/logout') {
        if (!sameOrigin(req)) return json(res, 403, { success: false, code: 'origin_rejected' })
        return json(res, 200, { success: true }, { 'set-cookie': sessionCookie('', 0) })
      }
      if (req.method === 'GET' && pathname === '/v1/session') {
        const session = parseSession(req, sessionSecret)
        return session ? json(res, 200, { success: true, data: { username: session.username, role: session.role, tenantId: session.tenantId, mustChangePassword: Boolean(session.mustChangePassword) } }) : json(res, 401, { success: false, code: 'unauthorized' })
      }
      if (pathname.startsWith('/v1/') && !sameOrigin(req) && req.method !== 'GET') return json(res, 403, { success: false, code: 'origin_rejected' })
      if (pathname === '/v1/admin/billing' && req.method === 'GET') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await billing.overview(undefined, { includeCalls: false }) })
      }
      if (pathname === '/v1/admin/billing/calls' && req.method === 'GET') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await billing.logs(url.searchParams.get('tenantId')) })
      }
      if (pathname === '/v1/account/billing' && req.method === 'GET') {
        const session = requireRole(req, res, sessionSecret, 'tenant_admin'); if (!session) return
        return json(res, 200, { success: true, data: await billing.overview(session.tenantId) })
      }
      if (pathname === '/v1/admin/billing/pricing' && req.method === 'PUT') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await billing.savePricing(await readJson(req), session.id) })
      }
      if (pathname === '/v1/admin/model-keys' && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 201, { success: true, data: await service.issueModelKey({ ...(await readJson(req)), actorId: session.id }) })
      }
      if (pathname === '/v1/admin/billing/balance' && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const input = await readJson(req)
        return json(res, 200, { success: true, data: await billing.setBalance({ ...input, actorId: session.id }) })
      }
      if (pathname === '/v1/admin/billing/reconcile' && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await billing.reconcile({ ...(await readJson(req)), actorId: session.id }) })
      }
      if (req.method === 'POST' && pathname === '/v1/admin/local-pairings') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 201, { success: true, data: await localPairing.issue({ ...(await readJson(req)), actorId: session.id }) })
      }
      if (req.method === 'GET' && pathname === '/v1/admin/local-clients') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        const data = await store.snapshot()
        return json(res, 200, { success: true, data: data.localClients.map(({ tokenHash, ...row }) => row) })
      }
      if (req.method === 'POST' && pathname === '/v1/account/local-pairings') {
        const session = requireRole(req, res, sessionSecret, 'tenant_admin'); if (!session) return
        return json(res, 201, { success: true, data: await localPairing.issue({ ...(await readJson(req)), tenantId: session.tenantId, actorId: session.id }) })
      }
      if (req.method === 'POST' && pathname === '/v1/local-shop/pair') {
        if (!pairingLimiter.allow(req.socket.remoteAddress || 'unknown')) return json(res, 429, { success: false, code: 'too_many_attempts' })
        try { return json(res, 201, { success: true, data: await localPairing.exchange(await readJson(req, 4096)) }) }
        catch { return json(res, 401, { success: false, code: 'local_pairing_rejected', message: '配对码已失效或已使用，请重新生成' }) }
      }
      if (req.method === 'GET' && pathname === '/v1/local-shop/discovery') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        if (!await localPairing.authenticate(token)) return json(res, 401, { success: false, code: 'local_client_unauthorized' })
        return json(res, 200, { success: true, data: await localPairing.discovery(token) })
      }
      if (req.method === 'POST' && pathname === '/v1/local-shop/send-image') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const client = await localPairing.authenticate(token)
        if (!client) return json(res, 401, { success: false })
        const body = await readJson(req, 7 * 1024 * 1024)
        if (!client.bindings?.some(binding => binding.gatewayAccountId === body.installationId)) return json(res, 403, { success: false })
        if (typeof body.imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64) || !/^[a-zA-Z0-9_-]{1,120}$/.test(body.requestId || '')) return json(res, 400, { success: false, message: '图片或发送任务无效' })
        const buffer = Buffer.from(body.imageBase64, 'base64')
        const mimeType = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg' : ''
        if (!mimeType || buffer.length > 5 * 1024 * 1024 || buffer.length < 16) return json(res, 400, { success: false, message: '请选择 5MB 以内的 PNG 或 JPG 图片' })
        const data = await store.snapshot()
        const conversation = data.conversations.find(row => row.tenantId === client.tenantId && row.installationId === body.installationId && row.externalUserId === body.targetUserId && row.channel === 'wechat_shop')
        if (!conversation) return json(res, 404, { success: false, message: '店铺会话不存在' })
        const binding = client.bindings.find(row => row.gatewayAccountId === body.installationId)
        const report = async status => { try { await messaging.publishLocalStatus?.(client, { ...status, commandId: body.requestId, localMessageId: body.requestId, conversationId: body.localConversationId, channel: 'wechat_shop', accountId: binding.accountId }) } catch { /* HTTP still returns the platform result; never change sent into failed for a local delivery error. */ } }
        try {
          const result = await messaging.sendReply(conversation.id, '[图片]', client.id, body.requestId, body.installationId, { buffer, mimeType })
          await report({status:'sent',channelMessageId:result.channelMessageId})
          return json(res, 200, { success: true, data: { success: true, status: 'sent', channelMsgId: result.channelMessageId } })
        } catch (error) {
          await report({status:error.code === 'shop_transport_error' ? 'unknown' : 'failed',errorCode:error.code,errorMessage:error.message})
          if (error.code === 'shop_transport_error') return json(res, 200, { success: true, data: { success: false, status: 'unknown', error: '发送结果待确认，请勿重复发送' } })
          throw error
        }
      }
      const localMedia = pathname.match(/^\/v1\/local-shop\/media\/([a-zA-Z0-9-]+)$/)
      if (req.method === 'POST' && pathname === '/v1/local-shop/detach') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const client = await localPairing.authenticate(token)
        if (!client) return json(res, 401, { success: false })
        const body = await readJson(req)
        const snapshot = await store.snapshot()
        if (!snapshot.shopInstallations.some(row => row.id === body.installationId && row.tenantId === client.tenantId)) return json(res, 403, { success: false })
        return json(res, 200, { success: true, data: await localPairing.detach(client.id, body.installationId) })
      }
      if (req.method === 'POST' && pathname === '/v1/local-shop/disconnect') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const client = await localPairing.authenticate(token)
        if (!client) return json(res, 401, { success: false, code: 'local_client_unauthorized' })
        return json(res, 200, { success: true, data: await localPairing.revoke(client.id, client.tenantId, client.id) })
      }
      if (req.method === 'GET' && localMedia) {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const client = await localPairing.authenticate(token)
        if (!client) return json(res, 401, { success: false, code: 'local_client_unauthorized' })
        const data = await store.snapshot()
        const message = data.messages.find(row => row.id === localMedia[1] && row.channel === 'wechat_shop' && row.tenantId === client.tenantId &&
          client.bindings?.some(binding => binding.gatewayAccountId === row.installationId))
        if (!message) return json(res, 404, { success: false, code: 'not_found' })
        const image = await messaging.image(message.id)
        return binary(res, 200, image.buffer, image.contentType)
      }
      const localRevoke = pathname.match(/^\/v1\/(admin|account)\/local-clients\/([a-zA-Z0-9-]+)\/revoke$/)
      if (localRevoke && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, localRevoke[1] === 'admin' ? 'operator' : 'tenant_admin'); if (!session) return
        const body = await readJson(req)
        return json(res, 200, { success: true, data: await localPairing.revoke(localRevoke[2], session.role === 'operator' ? body.tenantId : session.tenantId, session.id) })
      }

      if (pathname === '/v1/admin/shops/drafts' && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 201, { success: true, data: await wechatShop.createDraft(await readJson(req), session.id) })
      }
      if (pathname === '/v1/admin/shops' && req.method === 'GET') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await wechatShop.list() })
      }
      if (pathname === '/v1/admin/shops' && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 201, { success: true, data: await wechatShop.save(await readJson(req), session.id) })
      }
      const shopCallbackConfig = pathname.match(/^\/v1\/admin\/shops\/([a-zA-Z0-9-]+)\/callback-config$/)
      if (shopCallbackConfig && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await wechatShop.callbackConfig(shopCallbackConfig[1], session.id) })
      }
      const shopDisconnect = pathname.match(/^\/v1\/admin\/shops\/([a-zA-Z0-9-]+)\/disconnect$/)
      if (shopDisconnect && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const snapshot = await store.snapshot(), id = shopDisconnect[1]
        const shop = snapshot.shopInstallations.find(row => row.id === id)
        if (!shop) return json(res, 404, { success: false, message: '店铺不存在，请刷新列表' })
        const owners = snapshot.localClients.filter(row => row.status === 'active' && row.tenantId === shop.tenantId && row.bindings?.some(binding => binding.gatewayAccountId === id))
        for (const owner of owners) await localPairing.detach(owner.id, id, session.id)
        return json(res, 200, { success: true, data: { disconnected: true } })
      }
      const shopDelete = pathname.match(/^\/v1\/admin\/shops\/([a-zA-Z0-9-]+)\/delete$/)
      if (shopDelete && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const body = await readJson(req)
        return json(res, 200, { success: true, data: await wechatShop.remove(shopDelete[1], body.confirmName, session.id) })
      }
      const shopTest = pathname.match(/^\/v1\/admin\/shops\/([a-zA-Z0-9-]+)\/test$/)
      if (shopTest && req.method === 'POST') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await wechatShop.test(shopTest[1], session.id) })
      }

      if (req.method === 'GET' && pathname === '/v1/admin/overview') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await service.adminOverview() })
      }
      if (req.method === 'POST' && pathname === '/v1/admin/tenants') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const tenant = await service.createTenant({ ...(await readJson(req)), actorId: session.id })
        return json(res, 201, { success: true, data: tenant })
      }
      if (req.method === 'POST' && pathname === '/v1/admin/credits/grant') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const body = await readJson(req)
        const result = await ledger.grant({ ...body, actorId: session.id, idempotencyKey: String(req.headers['idempotency-key'] || body.idempotencyKey || crypto.randomUUID()) })
        return json(res, 201, { success: true, data: result })
      }
      if (req.method === 'POST' && pathname === '/v1/admin/wecom/installations') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const installation = await service.registerWecomInstallation({ ...(await readJson(req)), actorId: session.id })
        return json(res, 201, { success: true, data: installation })
      }
      if (req.method === 'POST' && pathname === '/v1/admin/wecom/install-url') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await wecomSuite.createInstallUrl(env.WECOM_INSTALL_REDIRECT_URI || 'https://provider.thelonelybrave.cn/wecom/install/complete') })
      }
      if (req.method === 'GET' && pathname === '/v1/admin/ai/config') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await messaging.getModelConfig() })
      }
      if (req.method === 'PUT' && pathname === '/v1/admin/ai/config') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await messaging.saveModelConfig(await readJson(req), session.id) })
      }
      if (req.method === 'POST' && pathname === '/v1/admin/ai/test') {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await messaging.testModel(await readJson(req), session.id) })
      }
      if (req.method === 'GET' && pathname === '/v1/admin/inbox') {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        return json(res, 200, { success: true, data: await messaging.inbox(url.searchParams.get('conversationId')) })
      }
      const profileMatch = pathname.match(/^\/v1\/admin\/inbox\/([^/]+)\/customer$/)
      if (req.method === 'PUT' && profileMatch) {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 410, { success: false, message: '远端备注已停用，请在本地工作台备注' })
      }
      const ordersMatch = pathname.match(/^\/v1\/admin\/inbox\/([^/]+)\/orders$/)
      if (req.method === 'POST' && ordersMatch) {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 200, { success: true, data: await customerOrders.list(ordersMatch[1], await readJson(req, 16384), session.id) })
      }
      const mediaMatch = pathname.match(/^\/v1\/admin\/messages\/([^/]+)\/media$/)
      if (req.method === 'GET' && mediaMatch) {
        if (!requireRole(req, res, sessionSecret, 'operator')) return
        const media = await messaging.image(decodeURIComponent(mediaMatch[1]))
        return binary(res, 200, media.buffer, media.contentType)
      }
      const draftMatch = pathname.match(/^\/v1\/admin\/inbox\/([^/]+)\/draft$/)
      if (req.method === 'POST' && draftMatch) {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        return json(res, 201, { success: true, data: await messaging.generateDraft(draftMatch[1], session.id) })
      }
      const replyMatch = pathname.match(/^\/v1\/admin\/inbox\/([^/]+)\/replies$/)
      if (req.method === 'POST' && replyMatch) {
        const session = requireRole(req, res, sessionSecret, 'operator'); if (!session) return
        const body = await readJson(req)
        if (body.requestId && !/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId)) return json(res, 400, { success: false, message: '发送任务编号无效' })
        return json(res, 201, { success: true, data: await messaging.sendReply(replyMatch[1], body.text, session.id, body.requestId) })
      }
      if (req.method === 'POST' && pathname === '/v1/internal/inbound') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        if (!secureTokenEqual(token, internalToken)) return json(res, 401, { success: false, code: 'invalid_internal_token' })
        return json(res, 202, { success: true, data: await messaging.ingestInbound(await readJson(req)) })
      }
      if (req.method === 'POST' && pathname === '/v1/internal/wecom/events') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        if (!secureTokenEqual(token, internalToken)) return json(res, 401, { success: false, code: 'invalid_internal_token' })
        const body = await readJson(req)
        const result = ['command', 'install_complete'].includes(body.kind) ? await wecomSuite.handleCommand(body.metadata || {}) : body.kind === 'data' ? await wecomSuite.handleData(body.event || {}) : null
        if (!result) return json(res, 400, { success: false, code: 'invalid_wecom_event' })
        return json(res, 202, { success: true, data: result })
      }
      if (req.method === 'GET' && pathname === '/v1/account/overview') {
        const session = requireRole(req, res, sessionSecret, 'tenant_admin'); if (!session) return
        return json(res, 200, { success: true, data: await service.accountOverview(session.tenantId) })
      }
      if (req.method === 'POST' && pathname === '/v1/account/devices') {
        const session = requireRole(req, res, sessionSecret, 'tenant_admin'); if (!session) return
        const body = await readJson(req)
        return json(res, 201, { success: true, data: await service.issueDevice({ tenantId: session.tenantId, name: body.name, actorId: session.id }) })
      }
      if (req.method === 'POST' && pathname === '/v1/credits/reservations') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const device = await service.authenticateDevice(token)
        if (!device) return json(res, 401, { success: false, code: 'invalid_device_token' })
        const result = await ledger.reserve({ ...(await readJson(req)), tenantId: device.tenantId, deviceId: device.id, idempotencyKey: String(req.headers['idempotency-key'] || '') })
        return json(res, 201, { success: true, data: result })
      }
      const settleMatch = pathname.match(/^\/v1\/credits\/reservations\/([^/]+)\/(settle|cancel)$/)
      if (req.method === 'POST' && settleMatch) {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const device = await service.authenticateDevice(token)
        if (!device) return json(res, 401, { success: false, code: 'invalid_device_token' })
        const body = await readJson(req)
        const result = settleMatch[2] === 'settle'
          ? await ledger.settle({ tenantId: device.tenantId, reservationId: settleMatch[1], actualCredits: body.actualCredits })
          : await ledger.cancel({ tenantId: device.tenantId, reservationId: settleMatch[1] })
        return json(res, 200, { success: true, data: result })
      }
      return json(res, 404, { success: false, code: 'not_found' })
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'control_plane.request_failed',
        method: req.method,
        path: pathname,
        code: String(error.code || 'unexpected_error'),
        errorType: String(error.name || 'Error'),
        at: new Date().toISOString()
      }))
      const known = publicError(error)
      const status = error.code === 'payload_too_large' ? 413 : ['tenant_conflict', 'username_conflict', 'corp_id_conflict', 'billing_conflict', 'billing_pending'].includes(error.code) ? 409 : ['insufficient_credits', 'insufficient_balance'].includes(error.code) ? 402 : error.code === 'wecom_not_ready' ? 503 : 400
      const safeBilling = ['billing_invalid', 'billing_conflict', 'billing_pending', 'insufficient_balance', 'vision_not_configured', 'usage_missing', 'usage_invalid', 'model_not_available'].includes(error.code)
      return json(res, status, { success: false, ...known, ...(safeBilling ? { code: error.code, message: error.message } : {}), ...(pathname === '/v1/chat/completions' ? { ...(error.billing ? { billing: error.billing } : {}), error: { message: safeBilling ? error.message : known.message, type: error.code || 'model_error' } } : {}) })
    }
  }

  return { handler, store, ledger, billing, service, messaging, wecomSuite, wechatShop, localPairing, ready }
}

function startControlPlane(options = {}) {
  const controlPlane = createControlPlane(options)
  const server = http.createServer(controlPlane.handler)
  const env = options.env || process.env
  const { LocalShopTransport } = require('./localShopTransport')
  const localTransport = new LocalShopTransport({ server, pairing: controlPlane.localPairing, store: controlPlane.store, messaging: controlPlane.messaging,
    directory: path.join(path.dirname(controlPlane.store.filePath), 'local-shop-outbox') })
  controlPlane.messaging.publishLocalStatus = (client, payload) => localTransport.publishStatus(client, payload)
  controlPlane.wechatShop.purgeDelivery = (id, clients) => localTransport.purgeShop(id, clients)
  server.listen(Number(env.CONTROL_PLANE_PORT || 8790), env.CONTROL_PLANE_HOST || '127.0.0.1')
  return { ...controlPlane, server, localTransport }
}

if (require.main === module) startControlPlane()

module.exports = { createControlPlane, startControlPlane, surfaceFor }
