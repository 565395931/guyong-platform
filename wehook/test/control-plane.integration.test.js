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
        const buffer = Buffer.concat(chunks)
        const contentType = String(res.headers['content-type'] || '')
        const raw = buffer.toString('utf8')
        resolve({ status: res.statusCode, body: contentType.includes('application/json') ? (raw ? JSON.parse(raw) : null) : buffer, contentType, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] })
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
  const adjusted = await request(server, { method: 'POST', path: '/v1/admin/billing/balance', cookie: login.cookie, body: { tenantId, amountYuan: 9, expectedBalance: 0, reference: '余额联调', idempotencyKey: 'direct-adjust' } })
  assert.equal(adjusted.status, 200)
  const deniedAdjust = await request(server, { method: 'POST', path: '/v1/admin/billing/balance', host: 'account.lonely-warrior.online', cookie: tenantLogin.cookie, body: { tenantId, amountYuan: 100, expectedBalance: 9e9, reference: '越权', idempotencyKey: 'denied-adjust' } })
  assert.equal(deniedAdjust.status, 403)
  const wallet = await request(server, { path: '/v1/billing/account', host: 'api.lonely-warrior.online', token: issued.body.data.token })
  assert.equal(wallet.body.data.balance, 9e9)
  assert.equal(wallet.body.data.unit, 1e9)
  const billingSummary = await request(server, { path: '/v1/admin/billing', cookie: login.cookie })
  assert.deepEqual(billingSummary.body.data.calls, [])
  const scopedCalls = await request(server, { path: '/v1/admin/billing/calls?tenantId=' + tenantId, cookie: login.cookie })
  assert.equal(scopedCalls.body.data.tenantId, tenantId)
  assert.equal(scopedCalls.body.data.limit, 300)
  const deniedCalls = await request(server, { path: '/v1/admin/billing/calls?tenantId=' + tenantId, cookie: tenantLogin.cookie })
  assert.equal(deniedCalls.status, 403)
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

test('operator configures an OpenAI-compatible model and manually replies from the inbox', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-inbox-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { NODE_ENV: 'test', CONTROL_PLANE_STORE_PATH: path.join(directory, 'store.json'), CONTROL_PLANE_ADMIN_USERNAME: 'operator', CONTROL_PLANE_ADMIN_PASSWORD: 'correct-horse-battery', CONTROL_PLANE_SESSION_SECRET: '0123456789abcdef0123456789abcdef', CONTROL_PLANE_INTERNAL_TOKEN: 'internal-test-token' }
  const modelClient = {
    normalizeBaseUrl: value => String(value).replace(/\/$/, ''),
    async complete(config) { assert.equal(config.apiKey, 'sk-test-secret'); return { content: '建议回复内容', model: config.model, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } }
  }
  const sends = []
  const mediaReads = []
  const control = createControlPlane({ env, modelClient, wecomSender: {
    async sendText(input) { sends.push(input); return { channelMessageId: 'out-1' } },
    async downloadMedia(input) { mediaReads.push(input); return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'application/octet-stream' } }
  } })
  const server = http.createServer(control.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const login = await request(server, { method: 'POST', path: '/v1/auth/login', body: { username: 'operator', password: env.CONTROL_PLANE_ADMIN_PASSWORD } })
  const changed = await request(server, { method: 'POST', path: '/v1/auth/password', cookie: login.cookie, body: { currentPassword: env.CONTROL_PLANE_ADMIN_PASSWORD, newPassword: 'a-new-secure-password' } })
  const cookie = changed.cookie
  const tenant = await request(server, { method: 'POST', path: '/v1/admin/tenants', cookie, body: { name: '消息测试企业', slug: 'message-demo', accountUsername: 'message-admin', accountPassword: 'tenant-password-123' } })
  await request(server, { method: 'POST', path: '/v1/admin/wecom/installations', cookie, body: { tenantId: tenant.body.data.id, companyName: '消息测试企业', corpId: 'wwMessage123' } })
  const configured = await request(server, { method: 'PUT', path: '/v1/admin/ai/config', cookie, body: { baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test-secret', model: 'deepseek-chat', systemPrompt: '专业回复' } })
  assert.equal(configured.status, 200)
  assert.equal(configured.body.data.apiKeyPreview.includes('secret'), false)
  const tested = await request(server, { method: 'POST', path: '/v1/admin/ai/test', cookie, body: {} })
  assert.equal(tested.body.data.ok, true)
  const inbound = await request(server, { method: 'POST', path: '/v1/internal/inbound', token: env.CONTROL_PLANE_INTERNAL_TOKEN, body: { corpId: 'wwMessage123', openKfId: 'wk-1', externalUserId: 'external-1', channelMessageId: 'in-1', text: '测试消息' } })
  assert.equal(inbound.status, 202)
  const inbox = await request(server, { path: '/v1/admin/inbox', cookie })
  assert.equal(inbox.body.data.messages[0].text, '测试消息')
  const imageInbound = await request(server, { method: 'POST', path: '/v1/internal/inbound', token: env.CONTROL_PLANE_INTERNAL_TOKEN, body: { corpId: 'wwMessage123', openKfId: 'wk-1', externalUserId: 'external-1', channelMessageId: 'image-1', messageType: 'image', mediaId: 'media-secret-1', text: '[图片消息]' } })
  const imageMessageId = imageInbound.body.data.id
  const imageWithoutSession = await request(server, { path: `/v1/admin/messages/${imageMessageId}/media` })
  assert.equal(imageWithoutSession.status, 401)
  const image = await request(server, { path: `/v1/admin/messages/${imageMessageId}/media`, cookie })
  assert.equal(image.status, 200)
  assert.equal(image.contentType, 'image/jpeg')
  assert.deepEqual(image.body, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  assert.equal(mediaReads[0].mediaId, 'media-secret-1')
  const conversationId = inbox.body.data.selected.id
  await control.messaging.saveModelConfig({ baseUrl: 'https://api.example.test/v1', model: 'deepseek-chat', visionModel: 'vision-test' }, 'operator')
  await control.billing.issue({ tenantId: tenant.body.data.id, actorId: 'operator', reference: 'draft-test', test: true, idempotencyKey: 'draft-package' })
  const draft = await request(server, { method: 'POST', path: `/v1/admin/inbox/${conversationId}/draft`, cookie, body: {} })
  assert.equal(draft.body.data.text, '建议回复内容')
  const reply = await request(server, { method: 'POST', path: `/v1/admin/inbox/${conversationId}/replies`, cookie, body: { text: '人工确认后的回复' } })
  assert.equal(reply.body.data.status, 'sent')
  assert.equal(sends.length, 1)
})
