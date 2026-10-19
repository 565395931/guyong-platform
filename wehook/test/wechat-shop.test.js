const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { FileSaasStore } = require('../src/saas/fileSaasStore')
const { createSecretCipher } = require('../src/saas/secretCipher')
const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')
const CloudMessagingService = require('../src/saas/cloudMessagingService')
const WechatShopService = require('../src/saas/wechatShopService')
const { createWechatShopClient, validateMediaUrl } = require('../src/saas/wechatShopClient')
const { createControlPlane } = require('../src/saas/controlPlaneServer')

const appId = 'wx1234567890abcdef'
const token = 'shopCallbackToken123'
const aesKey = Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '')
const now = Date.parse('2026-10-08T10:00:00Z')
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new FileSaasStore(path.join(directory, 'data.json'))
  const cipher = createSecretCipher(Buffer.alloc(32, 4).toString('base64'))
  const calls = []; const aiCalls = []; let clock = now
  const client = {
    async getToken(input) { calls.push({ kind: 'token', ...input }); return { accessToken: 'access-token-fixture', expiresIn: 7200 } },
    async sendText(input) { calls.push({ kind: 'send', ...input }); return { channelMessageId: `out-${input.requestId}` } },
    async downloadMedia(input) { calls.push({ kind: 'image', ...input }); return { buffer: png } }
  }
  const messaging = new CloudMessagingService({ store, cipher, now: () => new Date(clock).toISOString(), modelClient: {
    normalizeBaseUrl: value => value,
    async complete(config, payload) { aiCalls.push(payload); return { content: '您好，已收到。', model: 'fixture', usage: {} } }
  } })
  const shop = new WechatShopService({ store, cipher, client, messaging, now: () => clock })
  messaging.shopSender = shop.sender()
  await store.transaction(data => {
    data.tenants.push({ id: 'tenant-a', status: 'active' }, { id: 'tenant-b', status: 'active' })
    data.wecomInstallations.push({ id: 'wecom-a', tenantId: 'tenant-a', corpId: 'wwtest' })
  })
  const input = { name: '测试小店', tenantId: 'tenant-a', appId, appSecret: 'shop-secret-fixture', token, encodingAESKey: aesKey }
  const installation = await shop.save(input, 'operator')
  return { directory, store, shop, messaging, client, calls, aiCalls, input, installation, clock: value => { clock = value } }
}

function event(overrides = {}) {
  return { Event: 'commkf_send_msg_to_kf', MsgType: 'event', ToUserName: 'gh_shop', FromUserName: 'openid-test', msg_id: 'msg-1', msg_type: 'text', msg_event: 'EVENT_TYPE_SEND_MSG', CreateTime: now / 1000, text: { content: '你好' }, ...overrides }
}

function signed(data, overrides = {}) {
  const callback = createCallbackCrypto({ token, encodingAesKey: aesKey, receiveId: overrides.appId || appId })
  const timestamp = String(overrides.timestamp || now / 1000); const nonce = 'nonce-1'
  const encrypted = callback.encryptForTest(JSON.stringify(data))
  return { params: new URLSearchParams({ timestamp, nonce, msg_signature: callback.sign(timestamp, nonce, encrypted) }), envelope: { Encrypt: encrypted } }
}
async function receive(f, data = event(), overrides) {
  const { params, envelope } = signed(data, overrides)
  return f.shop.receive(f.installation.id, params, envelope)
}

test('remote shop deletion confirms name, backs up encrypted data and preserves unrelated shops', async t => {
  const f = await fixture(t)
  await receive(f)
  const other = await f.shop.save({ ...f.input, name: '其他店铺', appId: 'wxabcdef1234567890', tenantId: 'tenant-b' }, 'operator')
  await f.store.transaction(data => {
    data.localClients.push({ id: 'client-fixture', tenantId: 'tenant-a', status: 'active', bindings: [{ accountId: 1, gatewayAccountId: f.installation.id }], installationIds: [f.installation.id] })
    data.customerProfiles.push({ id: 'profile-fixture', installationId: f.installation.id })
    data.shopSends.push({ installationId: f.installation.id, requestId: 'old-fixture' })
  })
  const before = await f.store.snapshot()
  await assert.rejects(f.shop.remove(f.installation.id, '不正确的名称', 'operator'), { code: 'shop_invalid_config' })
  assert.deepEqual(await f.store.snapshot(), before)
  const result = await f.shop.remove(f.installation.id, f.input.name, 'operator')
  assert.equal(result.messageCount, 1)
  const after = await f.store.snapshot()
  assert.deepEqual(after.shopInstallations.map(row => row.id), [other.id])
  assert.equal(after.messages.length, 0); assert.equal(after.conversations.length, 0)
  assert.equal(after.customerProfiles.length, 0); assert.equal(after.shopSends.length, 0)
  assert.equal(after.localClients[0].status, 'revoked')
  const directory = path.join(f.directory, 'shop-delete-backups')
  const encrypted = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8')
  assert.equal(encrypted.includes(f.input.appSecret), false)
  assert.equal(JSON.parse(f.shop.cipher.decrypt(encrypted)).installation.id, f.installation.id)
  await assert.rejects(receive(f), { code: 'shop_not_found' })
})

test('remote delete refuses active sends and delivery purge failure leaves shop data intact', async t => {
  const f = await fixture(t)
  f.shop.sendLocks.set(f.installation.id + ':pending', Promise.resolve())
  await assert.rejects(f.shop.remove(f.installation.id, f.input.name, 'operator'), { code: 'shop_conflict' })
  f.shop.sendLocks.clear()
  f.shop.purgeDelivery = async () => { throw new Error('outbox unavailable') }
  await assert.rejects(f.shop.remove(f.installation.id, f.input.name, 'operator'), /outbox unavailable/)
  assert.equal((await f.shop.list()).length, 1)
})

test('shop credentials encrypt at rest, redact all secrets, preserve blank edits and reject rebind', async t => {
  const f = await fixture(t)
  const serialized = JSON.stringify(await f.store.snapshot())
  for (const secret of [f.input.appSecret, token, aesKey]) assert.equal(serialized.includes(secret), false)
  const publicConfig = JSON.stringify(await f.shop.list())
  assert.equal(publicConfig.includes('Encrypted'), false)
  assert.equal(publicConfig.includes(f.input.appSecret), false)
  await f.shop.save({ id: f.installation.id, tenantId: 'tenant-a', appId, name: '改名' }, 'operator')
  await f.shop.test(f.installation.id, 'operator')
  assert.equal(f.calls[0].appSecret, f.input.appSecret)
  await assert.rejects(f.shop.save({ ...f.input, id: f.installation.id, tenantId: 'tenant-b' }, 'operator'), { code: 'shop_invalid_config' })
  await assert.rejects(f.shop.save(f.input, 'operator'), { code: 'shop_conflict' })
})

test('first-save preview identity is preserved and cannot overwrite a registered shop', async t => {
  const f = await fixture(t)
  const callbackId = crypto.randomUUID()
  const input = { ...f.input, appId: 'wxabcdef1234567890', callbackId }
  const saved = await f.shop.save(input, 'operator')
  assert.equal(saved.id, callbackId)
  assert.equal(saved.callbackPath, `/v1/shop/callback/${callbackId}`)
  await assert.rejects(f.shop.save({ ...input, appId: 'wx1111111111111111' }, 'operator'), { code: 'shop_conflict' })
  await assert.rejects(f.shop.save({ ...input, appId: 'wx1111111111111111', callbackId: '../invalid' }, 'operator'), { code: 'shop_invalid_config' })
  assert.equal((await f.shop.list()).length, 2)
})

test('explicit callback disclosure is audited and leaves original credentials unchanged', async t => {
  const f = await fixture(t)
  const before = (await f.store.snapshot()).shopInstallations
  const result = await f.shop.callbackConfig(f.installation.id, 'operator')
  assert.deepEqual(result, { token, encodingAESKey: aesKey })
  const after = await f.store.snapshot()
  assert.deepEqual(after.shopInstallations, before)
  assert.ok(after.auditEntries.some(row => row.action === 'shop.callback_config_view' && row.actorId === 'operator'))
  assert.doesNotMatch(JSON.stringify(after.auditEntries), new RegExp(token))
  await assert.rejects(f.shop.callbackConfig('missing', 'operator'), { code: 'shop_not_found' })
})

test('draft address is live before save, verifies securely, then promotes without changing keys', async t => {
  const f = await fixture(t)
  const draft = await f.shop.createDraft({}, 'operator')
  assert.equal(await f.shop.verify(draft.id, new URLSearchParams()), 'callback ready')
  assert.equal((await f.shop.list()).length, 1)
  const timestamp = String(now / 1000), nonce = 'draft-check'
  const signature = crypto.createHash('sha1').update([draft.token, timestamp, nonce].sort().join('')).digest('hex')
  assert.equal(await f.shop.verify(draft.id, new URLSearchParams({ timestamp, nonce, signature, echostr: 'draft-echo' })), 'draft-echo')
  const input = { ...f.input, appId: 'wxabcdef1234567890', callbackId: draft.id, draftRequired: true, token: draft.token, encodingAESKey: draft.encodingAESKey }
  await assert.rejects(f.shop.save(input, 'other-operator'), { code: 'shop_not_ready' })
  await assert.rejects(f.shop.save({ ...input, token: 'wrong-token' }, 'operator'), { code: 'shop_invalid_config' })
  await assert.rejects(f.shop.receive(draft.id, new URLSearchParams(), {}), { code: 'shop_not_found' })
  const snapshot = await f.store.snapshot()
  assert.ok(!JSON.stringify(snapshot).includes(draft.token))
  assert.ok(!JSON.stringify(snapshot).includes(draft.encodingAESKey))
  const saved = await f.shop.save(input, 'operator')
  assert.equal(saved.callbackPath, draft.callbackPath)
  assert.ok(saved.verifiedAt)
  assert.deepEqual(await f.shop.callbackConfig(saved.id, 'operator'), { token: draft.token, encodingAESKey: draft.encodingAESKey })
  assert.equal((await f.store.snapshot()).shopDrafts.length, 0)
  assert.equal(f.calls.length, 0)
})

test('regeneration replaces only owned draft and expired drafts cannot save or verify', async t => {
  const f = await fixture(t)
  const old = await f.shop.createDraft({}, 'operator')
  const stable = JSON.stringify((await f.store.snapshot()).shopInstallations)
  await assert.rejects(f.shop.createDraft({ replaceId: old.id }, 'other'), { code: 'shop_not_ready' })
  const fresh = await f.shop.createDraft({ replaceId: old.id }, 'operator')
  assert.notEqual(fresh.id, old.id)
  assert.notEqual(fresh.token, old.token)
  assert.notEqual(fresh.encodingAESKey, old.encodingAESKey)
  await assert.rejects(f.shop.verify(old.id, new URLSearchParams()), { code: 'shop_not_found' })
  f.clock(now + 2 * 60 * 60 * 1000 + 1)
  await assert.rejects(f.shop.verify(fresh.id, new URLSearchParams()), { code: 'shop_not_found' })
  await assert.rejects(f.shop.save({ ...f.input, appId: 'wxabcdef1234567890', callbackId: fresh.id, draftRequired: true, token: fresh.token, encodingAESKey: fresh.encodingAESKey }, 'operator'), { code: 'shop_not_ready' })
  assert.equal(JSON.stringify((await f.store.snapshot()).shopInstallations), stable)
})

test('shop GET verification uses three-part signature and returns unencrypted echostr', async t => {
  const f = await fixture(t)
  const timestamp = String(now / 1000); const nonce = 'nonce'
  const signature = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
  const params = new URLSearchParams({ timestamp, nonce, signature, echostr: '123456789' })
  assert.equal(await f.shop.verify(f.installation.id, params), '123456789')
  assert.ok((await f.shop.list())[0].verifiedAt)
  params.set('signature', 'bad')
  await assert.rejects(f.shop.verify(f.installation.id, params), { code: 'shop_callback_rejected' })
})

test('shop POST checks ciphertext signature, AppID and replay age before persisting', async t => {
  const f = await fixture(t)
  const request = signed(event()); request.params.set('msg_signature', 'bad')
  await assert.rejects(f.shop.receive(f.installation.id, request.params, request.envelope), { code: 'shop_callback_rejected' })
  await assert.rejects(receive(f, event(), { appId: 'wxwrong1234567890x' }), { code: 'shop_callback_rejected' })
  await assert.rejects(receive(f, event(), { timestamp: now / 1000 - 15000 }), { code: 'shop_callback_rejected' })
  assert.equal((await f.store.snapshot()).messages.length, 0)
  assert.deepEqual(await receive(f, event({ Event: 'debug_demo' })), { ignored: true })
})

test('encrypted callbacks deduplicate after restart and do not collide with WeCom or another shop', async t => {
  const f = await fixture(t)
  await receive(f); await receive(f)
  const restarted = new WechatShopService({ store: f.store, cipher: f.messaging.cipher, client: f.client, messaging: f.messaging, now: () => now })
  const request = signed(event())
  await restarted.receive(f.installation.id, request.params, request.envelope)
  await f.messaging.ingestInbound({ corpId: 'wwtest', externalUserId: 'openid-test', openKfId: 'kf', channelMessageId: 'msg-1', text: '来自企微' })
  const other = await f.shop.save({ ...f.input, appId: 'wxabcdef1234567890', tenantId: 'tenant-b' }, 'operator')
  const otherRequest = signed(event(), { appId: other.appId })
  await f.shop.receive(other.id, otherRequest.params, otherRequest.envelope)
  const data = await f.store.snapshot()
  assert.equal(data.messages.length, 3)
  assert.equal(data.conversations.length, 3)
  assert.equal(data.conversations.filter(item => item.channel === 'wechat_shop').length, 2)
})

test('shop images remain private and AI receives full text/image history without drafts', async t => {
  const f = await fixture(t)
  await receive(f)
  const mediaUrl = 'https://channels.weixin.qq.com/shop/commkf/downloadmedia?encrypted_param=private-image'
  await receive(f, event({ msg_id: 'msg-2', msg_type: 'image', text: undefined, image: { cos_url: mediaUrl } }))
  const inbox = await f.messaging.inbox()
  assert.equal(JSON.stringify(inbox).includes('private-image'), false)
  assert.equal(JSON.stringify(await f.store.snapshot()).includes('private-image'), false)
  assert.ok(inbox.messages[1].mediaUrl)
  assert.equal((await f.messaging.image(inbox.messages[1].id)).contentType, 'image/png')
  await f.messaging.generateDraft(inbox.selected.id, 'operator')
  await f.messaging.generateDraft(inbox.selected.id, 'operator')
  assert.equal(f.aiCalls[1].messages.length, 3)
  assert.match(f.aiCalls[1].messages[2].content[1].image_url.url, /^data:image\/png;base64,/)
})

test('shop preserves documented identity and structured card/reference fields, never guesses customer profile', async t => {
  const f = await fixture(t)
  await receive(f, event({ union_id: 'union-test', nickname: 'not-documented', avatar: 'https://invalid.example/avatar' }))
  await receive(f, event({ msg_id: 'order-meta', msg_type: 'order_share', text: undefined, order_share: { order_id: 'order-123', secret: 'discard-me' } }))
  await receive(f, event({ msg_id: 'ref-meta', msg_type: 'reference', text: undefined, reference: { content: '问一下', ref_msg: { msg_id: 'prior', msg_type: 1, content: '原文', from_name: '引用消息发送者' } } }))
  const inbox = await f.messaging.inbox()
  assert.equal(inbox.selected.unionId, 'union-test')
  assert.equal(inbox.selected.customerName, '客户 d-test')
  assert.deepEqual(inbox.messages[1].shopDetails, { orderId: 'order-123' })
  assert.equal(inbox.messages[2].shopDetails.reference.senderName, '引用消息发送者')
  assert.equal(JSON.stringify(inbox).includes('discard-me'), false)
  assert.equal(JSON.stringify(inbox).includes('not-documented'), false)
  assert.equal(JSON.stringify(inbox).includes('invalid.example'), false)
  assert.equal(f.calls.length, 0)
})

test('shop handles voice and card messages without claiming to query order details', async t => {
  const f = await fixture(t)
  await receive(f, event({ msg_id: 'voice', msg_type: 'voice', text: undefined, voice: { translated_msg: '什么时候发货' } }))
  await receive(f, event({ msg_id: 'order', msg_type: 'order_share', text: undefined, order_share: { order_id: 'order-123' } }))
  const messages = (await f.messaging.inbox()).messages
  assert.equal(messages[0].text, '什么时候发货')
  assert.equal(messages[1].text, '[订单卡片] order-123')
})

test('token requests coalesce and cached tokens survive service restart', async t => {
  const f = await fixture(t)
  await Promise.all([f.shop.accessToken(f.installation.id), f.shop.accessToken(f.installation.id)])
  const restarted = new WechatShopService({ store: f.store, cipher: f.messaging.cipher, client: f.client, now: () => now })
  assert.equal(await restarted.accessToken(f.installation.id), 'access-token-fixture')
  assert.equal(f.calls.filter(item => item.kind === 'token').length, 1)
  f.clock(now + 7200 * 1000)
  await f.shop.accessToken(f.installation.id)
  assert.equal(f.calls.filter(item => item.kind === 'token').length, 2)
})

test('manual shop replies deduplicate concurrent and retried requests', async t => {
  const f = await fixture(t); await receive(f)
  const id = (await f.messaging.inbox()).selected.id
  await Promise.all([f.messaging.sendReply(id, '回复', 'operator', 'request-1'), f.messaging.sendReply(id, '回复', 'operator', 'request-1')])
  await f.messaging.sendReply(id, '回复', 'operator', 'request-1')
  assert.equal(f.calls.filter(item => item.kind === 'send').length, 1)
  assert.equal((await f.store.snapshot()).messages.filter(item => item.direction === 'outbound').length, 1)
  await assert.rejects(f.messaging.sendReply(id, '改内容', 'operator', 'request-1'), { code: 'shop_conflict' })
})

test('uncertain sends remain uncertain without blindly sending again', async t => {
  const f = await fixture(t); await receive(f)
  const id = (await f.messaging.inbox()).selected.id; const attempts = []
  f.client.sendText = async input => {
    attempts.push(input.requestId)
    if (attempts.length === 1) throw Object.assign(new Error('timeout'), { code: 'shop_transport_error' })
    return { channelMessageId: 'delivered' }
  }
  await assert.rejects(f.messaging.sendReply(id, '回复', 'operator', 'same-task'), { code: 'shop_transport_error' })
  assert.equal((await f.store.snapshot()).messages.some(item => item.direction === 'outbound'), false)
  await assert.rejects(f.messaging.sendReply(id, '回复', 'operator', 'same-task'), {code:'shop_transport_error'})
  assert.deepEqual(attempts, ['same-task'])
})

test('reply policy enforces 5 per customer turn and 48 hours, including same-second messages', async t => {
  const f = await fixture(t); await receive(f)
  const id = (await f.messaging.inbox()).selected.id
  for (let index = 0; index < 5; index++) await f.messaging.sendReply(id, `回复${index}`, 'operator', `send-${index}`)
  await assert.rejects(f.messaging.sendReply(id, '第六条', 'operator', 'send-6'), { code: 'shop_reply_limit' })
  await receive(f, event({ msg_id: 'next-turn' }))
  await f.messaging.sendReply(id, '新一轮回复', 'operator', 'next-send')
  f.clock(now + 48 * 3600 * 1000)
  await assert.rejects(f.messaging.sendReply(id, '过期回复', 'operator', 'late-send'), { code: 'shop_reply_limit' })
})

test('media proxy blocks non-WeChat hosts, userinfo, ports and redirects', async () => {
  for (const url of ['http://127.0.0.1/test', 'https://channels.weixin.qq.com.evil.test/shop/commkf/downloadmedia', 'https://user@channels.weixin.qq.com/shop/commkf/downloadmedia', 'https://channels.weixin.qq.com/other', 'https://channels.weixin.qq.com:444/shop/commkf/downloadmedia']) assert.throws(() => validateMediaUrl(url), { code: 'shop_media_invalid' })
  const client = createWechatShopClient({ fetchImpl: async (url, options) => { assert.equal(options.redirect, 'error'); throw new Error('redirect') } })
  await assert.rejects(client.downloadMedia({ url: 'https://channels.weixin.qq.com/shop/commkf/downloadmedia' }), { code: 'shop_media_missing' })
})

test('official client uses stable token and send request_id, redacting upstream errors', async () => {
  const calls = []
  const client = createWechatShopClient({ fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return new Response(JSON.stringify(calls.length === 1 ? { access_token: 'access-fixture', expires_in: 7200 } : { errcode: 0, msg_id: 'out-1' }), { status: 200 })
  } })
  const credentials = await client.getToken({ appId, appSecret: 'secret-fixture' })
  assert.equal(calls[0].url, 'https://api.weixin.qq.com/cgi-bin/stable_token')
  assert.equal(calls[0].body.force_refresh, false)
  await client.sendText({ accessToken: credentials.accessToken, openId: 'openid', text: '您好', requestId: 'task-id' })
  assert.equal(calls[1].body.request_id, 'task-id')
  assert.equal(calls[1].body.text.content, '您好')
  const failed = createWechatShopClient({ fetchImpl: async () => new Response(JSON.stringify({ errcode: 40125, errmsg: 'leaked-secret-fixture' }), { status: 200 }) })
  await assert.rejects(failed.getToken({ appId, appSecret: 'secret-fixture' }), error => error.code === 'shop_api_error' && !error.message.includes('secret-fixture'))
})

test('HTTP routes authorize admin, verify public callbacks, persist before ack and support inbox reply', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-http-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { CONTROL_PLANE_STORE_PATH: path.join(directory, 'data.json'), CONTROL_PLANE_SESSION_SECRET: 'a'.repeat(32), CONTROL_PLANE_ADMIN_PASSWORD: 'fixture-password', CONTROL_PLANE_ADMIN_MUST_CHANGE_PASSWORD: 'false' }
  const sends = []
  const control = createControlPlane({ env, wechatShopClient: { async getToken() { return { accessToken: 'fixture', expiresIn: 7200 } }, async listOrders() { return { order_id_list: [], has_more: false } }, async sendText(input) { sends.push(input); return { channelMessageId: 'out' } } } })
  await control.ready
  const server = http.createServer(control.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (url, body, cookie) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await request('/v1/admin/shops')).status, 401)
  const login = await request('/v1/auth/login', { surface: 'admin', username: 'admin', password: env.CONTROL_PLANE_ADMIN_PASSWORD })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/v1/admin/shops/drafts', {})).status, 401)
  const draftResponse = await request('/v1/admin/shops/drafts', {}, cookie)
  assert.equal(draftResponse.status, 201)
  const draft = (await draftResponse.json()).data
  assert.equal(await (await request(draft.callbackPath)).text(), 'callback ready')
  const tenantResponse = await request('/v1/admin/tenants', { name: '客户', slug: 'shop-customer', accountUsername: 'customer', accountPassword: 'customer-password' }, cookie)
  const tenantId = (await tenantResponse.json()).data.id
  const savedResponse = await request('/v1/admin/shops', { tenantId, name: '小店', appId, appSecret: 'fixture-secret', token, encodingAESKey: aesKey }, cookie)
  assert.equal(savedResponse.status, 201)
  const saved = (await savedResponse.json()).data
  const disclosurePath = `/v1/admin/shops/${saved.id}/callback-config`
  assert.equal((await request(disclosurePath, {})).status, 401)
  assert.equal((await request(disclosurePath, null, cookie)).status, 404)
  const disclosed = await request(disclosurePath, {}, cookie)
  assert.equal(disclosed.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await disclosed.json()).data, { token, encodingAESKey: aesKey })
  const crossOrigin = await fetch(base + disclosurePath, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(crossOrigin.status, 403)
  const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'http-nonce'
  const signature = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
  const verified = await request(saved.callbackPath + '?' + new URLSearchParams({ timestamp, nonce, signature, echostr: 'echo-value' }))
  assert.equal(await verified.text(), 'echo-value')
  const callback = createCallbackCrypto({ token, encodingAesKey: aesKey, receiveId: appId })
  const encrypted = callback.encryptForTest(JSON.stringify(event({ CreateTime: Number(timestamp) })))
  const params = new URLSearchParams({ timestamp, nonce, msg_signature: callback.sign(timestamp, nonce, encrypted) })
  assert.equal(await (await request(saved.callbackPath + '?' + params, { Encrypt: encrypted })).text(), 'success')
  const inbox = (await (await request('/v1/admin/inbox', null, cookie)).json()).data
  assert.equal(inbox.selected.channel, 'wechat_shop')
  const profilePath = `/v1/admin/inbox/${inbox.selected.id}/customer`
  const putProfile = (cookie, origin) => fetch(base + profilePath, { method: 'PUT', headers: { cookie, ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ remark: '测试备注', tags: ['隔热膜'], revision: 0 }) })
  assert.equal((await putProfile(cookie, 'https://evil.example')).status, 403)
  assert.equal((await putProfile(cookie)).status, 410)
  const ordersPath = `/v1/admin/inbox/${inbox.selected.id}/orders`
  assert.equal((await request(ordersPath, {})).status, 401)
  const orderResponse = await request(ordersPath, {}, cookie)
  assert.equal(orderResponse.status, 200)
  assert.equal(orderResponse.headers.get('cache-control'), 'no-store')
  assert.equal((await request(`/v1/admin/inbox/${inbox.selected.id}/replies`, { text: '测试', requestId: 'http-task' }, cookie)).status, 201)
  assert.equal(sends.length, 1)
  const tenantLogin = await request('/v1/auth/login', { surface: 'account', username: 'customer', password: 'customer-password' })
  assert.equal((await request('/v1/admin/shops', null, tenantLogin.headers.get('set-cookie').split(';')[0])).status, 403)
  assert.equal((await request(ordersPath, {}, tenantLogin.headers.get('set-cookie').split(';')[0])).status, 403)
  assert.equal((await putProfile(tenantLogin.headers.get('set-cookie').split(';')[0])).status, 403)
  assert.equal((await request(disclosurePath, {}, tenantLogin.headers.get('set-cookie').split(';')[0])).status, 403)
  assert.equal((await request('/v1/admin/shops/drafts', {}, tenantLogin.headers.get('set-cookie').split(';')[0])).status, 403)
  const bad = await request(saved.callbackPath + '?' + params, { Encrypt: 'bad' })
  assert.notEqual(bad.status, 200)
})


test('图片上传后发送，重复任务不重复上传或发送，并校验内容', async t => {
  const f = await fixture(t); await receive(f)
  let uploads = 0, sends = 0
  f.client.uploadImage = async input => { uploads++; assert.equal(input.openId, 'openid-test'); return {cosUrl:'https://channels.weixin.qq.com/shop/commkf/downloadmedia?fixture=image'} }
  f.client.sendImage = async input => { sends++; assert.ok(input.cosUrl); return {channelMessageId:'image-receipt'} }
  const snapshot = await f.store.snapshot()
  const image = {buffer: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]), mimeType:'image/png'}
  const args = [snapshot.conversations[0].id, '[图片]', 'fixture', 'image-test', f.installation.id, image]
  const first = await f.messaging.sendReply(...args), second = await f.messaging.sendReply(...args)
  assert.equal(first.channelMessageId, 'image-receipt'); assert.equal(first.messageType,'image')
  assert.equal(first.id, second.id); assert.equal(uploads,1); assert.equal(sends,1)
  await assert.rejects(f.messaging.sendReply(...args.slice(0,5), {...image,buffer:Buffer.concat([image.buffer,Buffer.from([1])])}),{code:'shop_conflict'})
})

test('风控失败记录错误码，网络结果不确定时不能重复发送',async t=>{
  const f = await fixture(t); await receive(f)
  const conversation = (await f.store.snapshot()).conversations[0]; let calls=0
  f.client.sendText=async()=>{calls++;throw Object.assign(Error('风控拒绝（10190010）'),{code:'shop_api_error',shopCode:10190010})}
  await assert.rejects(f.messaging.sendReply(conversation.id,'test','fixture','risk-task'),{shopCode:10190010})
  const failed=(await f.store.snapshot()).shopSends[0]
  assert.equal(failed.status,'failed');assert.equal(failed.shopCode,10190010)
  f.client.sendText=async()=>{calls++;throw Object.assign(Error('timeout'),{code:'shop_transport_error'})}
  await assert.rejects(f.messaging.sendReply(conversation.id,'test2','fixture','unknown-task'),{code:'shop_transport_error'})
  await assert.rejects(f.messaging.sendReply(conversation.id,'test2','fixture','unknown-task'),{code:'shop_transport_error'})
  assert.equal(calls,2)
})


test('本地图片接口鉴权、店铺隔离、类型限制和最终回执', async t => {
 const f=await fixture(t);await receive(f)
 const {createControlPlane}=require('../src/saas/controlPlaneServer')
 let delivered=0,reports=[]
 f.messaging.sendReply=async (id,text,actor,requestId,installationId,image)=>{delivered++;assert.equal(installationId,f.installation.id);assert.equal(image.mimeType,'image/png');return {channelMessageId:'http-image-receipt'}}
 f.messaging.publishLocalStatus=async(client,payload)=>reports.push(payload)
 const plane=createControlPlane({store:f.store,cipher:f.messaging.cipher,messaging:f.messaging,wechatShopClient:f.client,env:{NODE_ENV:'test',CONTROL_PLANE_SESSION_SECRET:'fixture-'.repeat(8),CONTROL_PLANE_ADMIN_PASSWORD:'fixture-password',CONTROL_PLANE_ADMIN_MUST_CHANGE_PASSWORD:'false'}})
 plane.localPairing.authenticate=async token=>token==='local-fixture'?{id:'client-a',tenantId:'tenant-a',bindings:[{gatewayAccountId:f.installation.id,accountId:1}]}:null
 const server=http.createServer(plane.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const url='http://127.0.0.1:'+server.address().port+'/v1/local-shop/send-image'
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]).toString('base64')
 const body={installationId:f.installation.id,targetUserId:'openid-test',requestId:'http-image-test',localConversationId:'local-id',imageBase64:png}
 const send=(data,token='local-fixture')=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(data)})
 assert.equal((await send(body,'wrong')).status,401)
 assert.equal((await send({...body,installationId:'other-shop'})).status,403)
 assert.equal((await send({...body,imageBase64:Buffer.alloc(20).toString('base64')})).status,400)
 const response=await send(body);assert.equal(response.status,200);assert.equal((await response.json()).data.channelMsgId,'http-image-receipt')
 assert.equal(delivered,1);assert.equal(reports[0].status,'sent');assert.equal(reports[0].localMessageId,'http-image-test')
 assert.equal(reports[0].accountId,1)
})
