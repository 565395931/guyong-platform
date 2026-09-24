const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { createControlPlane } = require('../src/saas/controlPlaneServer')

function request(server, { method = 'GET', path: requestPath, host = 'admin.lonely-warrior.online', body, cookie, token, idempotencyKey }) {
  const address = server.address()
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, method, path: requestPath, headers: { host, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

test('operator and tenant flows stay separated, and device API meters credits', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-control-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { CONTROL_PLANE_STORE_PATH: path.join(directory, 'store.json'), CONTROL_PLANE_ADMIN_USERNAME: 'operator', CONTROL_PLANE_ADMIN_PASSWORD: 'correct-horse-battery', CONTROL_PLANE_SESSION_SECRET: '0123456789abcdef0123456789abcdef' }
  const control = createControlPlane({ env })
  const server = http.createServer(control.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const login = await request(server, { method: 'POST', path: '/v1/auth/login', body: { username: 'operator', password: env.CONTROL_PLANE_ADMIN_PASSWORD }, host: 'admin.lonely-warrior.online' })
  assert.equal(login.status, 200)
  assert.match(login.cookie, /^lw_session=/)
  assert.equal(login.body.data.mustChangePassword, true)
  const changed = await request(server, { method: 'POST', path: '/v1/auth/password', cookie: login.cookie, body: { currentPassword: env.CONTROL_PLANE_ADMIN_PASSWORD, newPassword: 'a-new-secure-password' } })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.data.mustChangePassword, false)
  login.cookie = changed.cookie

  const tenantCreated = await request(server, { method: 'POST', path: '/v1/admin/tenants', cookie: login.cookie, body: { name: '测试客户', slug: 'tenant-demo', accountUsername: 'tenant-admin', accountPassword: 'tenant-password-123' } })
  assert.equal(tenantCreated.status, 201)
  const tenantId = tenantCreated.body.data.id
  const grant = await request(server, { method: 'POST', path: '/v1/admin/credits/grant', cookie: login.cookie, idempotencyKey: 'grant-demo', body: { tenantId, credits: 1000, reason: '联调额度' } })
  assert.equal(grant.body.data.balance, 1000)
  const wecom = await request(server, { method: 'POST', path: '/v1/admin/wecom/installations', cookie: login.cookie, body: { tenantId, companyName: '测试企业', corpId: 'wwDemo12345' } })
  assert.equal(wecom.status, 201)

  const forbidden = await request(server, { path: '/v1/account/overview', cookie: login.cookie, host: 'account.lonely-warrior.online' })
  assert.equal(forbidden.status, 403)
  const tenantLogin = await request(server, { method: 'POST', path: '/v1/auth/login', host: 'account.lonely-warrior.online', body: { username: 'tenant-admin', password: 'tenant-password-123' } })
  assert.equal(tenantLogin.status, 200)
  const account = await request(server, { path: '/v1/account/overview', cookie: tenantLogin.cookie, host: 'account.lonely-warrior.online' })
  assert.equal(account.body.data.balance, 1000)
  assert.equal(account.body.data.installations.length, 1)

  const issued = await request(server, { method: 'POST', path: '/v1/account/devices', cookie: tenantLogin.cookie, host: 'account.lonely-warrior.online', body: { name: '测试电脑' } })
  assert.equal(issued.status, 201)
  const deviceToken = issued.body.data.token
  assert.match(deviceToken, /^lwd_/)
  const reserved = await request(server, { method: 'POST', path: '/v1/credits/reservations', host: 'api.lonely-warrior.online', token: deviceToken, idempotencyKey: 'model-call-1', body: { credits: 120, model: 'deepseek' } })
  assert.equal(reserved.status, 201)
  assert.equal(reserved.body.data.balance, 880)
  const settled = await request(server, { method: 'POST', path: `/v1/credits/reservations/${reserved.body.data.reservation.id}/settle`, host: 'api.lonely-warrior.online', token: deviceToken, body: { actualCredits: 100 } })
  assert.equal(settled.body.data.balance, 900)

  const snapshot = await control.store.snapshot()
  assert.equal(snapshot.devices[0].tokenHash.includes(deviceToken), false)
  assert.equal(snapshot.auditEntries.some(item => item.action === 'credits.grant'), true)
})

test('login errors are generic and surfaces reject the wrong role', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-auth-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { CONTROL_PLANE_STORE_PATH: path.join(directory, 'store.json'), CONTROL_PLANE_ADMIN_USERNAME: 'operator', CONTROL_PLANE_ADMIN_PASSWORD: 'correct-horse-battery', CONTROL_PLANE_SESSION_SECRET: '0123456789abcdef0123456789abcdef' }
  const control = createControlPlane({ env })
  const server = http.createServer(control.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const missing = await request(server, { method: 'POST', path: '/v1/auth/login', body: { username: 'missing', password: 'whatever-password' } })
  const wrong = await request(server, { method: 'POST', path: '/v1/auth/login', body: { username: 'operator', password: 'wrong-password' } })
  assert.equal(missing.body.message, wrong.body.message)
  const accountAttempt = await request(server, { method: 'POST', path: '/v1/auth/login', host: 'account.lonely-warrior.online', body: { username: 'operator', password: env.CONTROL_PLANE_ADMIN_PASSWORD } })
  assert.equal(accountAttempt.status, 401)
})
