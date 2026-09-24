const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { FileSaasStore } = require('./fileSaasStore')
const { TokenLedger } = require('./tokenLedger')
const ControlPlaneService = require('./controlPlaneService')
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

function publicError(error) {
  const known = new Set(['invalid_json', 'payload_too_large', 'invalid_tenant', 'tenant_conflict', 'username_conflict', 'weak_password', 'invalid_current_password', 'password_unchanged', 'tenant_not_found', 'invalid_corp_id', 'corp_id_conflict', 'invalid_credits', 'insufficient_credits', 'idempotency_key_required', 'reservation_not_found', 'reservation_not_active'])
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
  const loginLimiter = createRateLimiter()
  const ready = service.bootstrap({ adminUsername, adminPassword })

  async function handler(req, res) {
    await ready
    const url = new URL(req.url, 'http://control-plane.local')
    const pathname = url.pathname
    try {
      if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { status: 'ok', service: 'lonely-warrior-control-plane' })
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
      const known = publicError(error)
      const status = error.code === 'payload_too_large' ? 413 : ['tenant_conflict', 'username_conflict', 'corp_id_conflict'].includes(error.code) ? 409 : error.code === 'insufficient_credits' ? 402 : 400
      return json(res, status, { success: false, ...known })
    }
  }

  return { handler, store, ledger, service, ready }
}

function startControlPlane(options = {}) {
  const controlPlane = createControlPlane(options)
  const server = http.createServer(controlPlane.handler)
  const env = options.env || process.env
  server.listen(Number(env.CONTROL_PLANE_PORT || 8790), env.CONTROL_PLANE_HOST || '127.0.0.1')
  return { ...controlPlane, server }
}

if (require.main === module) startControlPlane()

module.exports = { createControlPlane, startControlPlane, surfaceFor }
