const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { LocalShopConnection, ADAPTER } = require('./localShopConnection')
const { createCredentialCipher } = require('../platform-connections/credentialCipher')
const { setDispatcher, getDispatcher } = require('./runtime')

function fixture() {
  const rows = [], calls = [], sent = [], inbound = []
  const cipher = createCredentialCipher({ key: Buffer.alloc(32, 3).toString('base64') })
  const accounts = {
    sequelize: { transaction: async fn => { const backup = rows.map(row => ({ ...row })); try { return await fn({}) } catch (error) { rows.splice(0, rows.length, ...backup); throw error } } },
    findAll: async ({ where }) => rows.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)),
    findByPk: async id => rows.find(row => row.id === id),
    create: async values => { const row = { ...values, id: rows.length + 1, update: async function(values) { Object.assign(this, values) } }; rows.push(row); return row },
    update: async (values, { where }) => { Object.assign(rows.find(row => row.id === where.id), values) }
  }
  const http = async (url, request) => {
    calls.push({ url, request })
    let data = {}
    if (url.endsWith('/pair')) data = { token: 'test-token-never-public', client: { id: 'client-a', tenantId: 'tenant-a' } }
    if (url.endsWith('/discovery')) data = { shops: [{ name: '成长资料铺', gatewayAccountId: 'shop-a', appId: 'wx-a' }] }
    return { ok: true, json: async () => ({ success: true, data }) }
  }
  const gatewayFactory = ({ accountEntries, options }) => {
    assert.equal(options.registerRuntime, false); assert.equal(options.allowShopAutoReply, true)
    assert.deepEqual(options.accountBindings, [{ accountId: 1, gatewayAccountId: 'shop-a' }])
    assert.equal(accountEntries[0].channel, 'wechat_shop')
    const link = new EventEmitter(); link.ready = true; link.stop = () => { link.stopped = true; link.ready = false }
    return { link, inbound: { handle: async envelope => { inbound.push(envelope); return 'ack' } }, dispatcher: { dispatch: async payload => { sent.push(payload); return { success: true, status: 'accepted' } } } }
  }
  return { rows, calls, sent, inbound, manager: new LocalShopConnection({ accounts, ...cipher, http, gatewayFactory }) }
}

test('pairing imports encrypted accounts, restores without duplicate links and routes manual replies per account', async () => {
  let fallback = 0
  setDispatcher({ dispatch: async () => { fallback++; return 'previous' } })
  const f = fixture()
  const result = await f.manager.pair('lwp_' + 'a'.repeat(43))
  assert.equal(result[0].shopNames[0], '成长资料铺')
  assert.equal(result[0].manualOnly, false)
  assert.equal(f.rows[0].adapter_type, ADAPTER)
  assert.equal(f.rows[0].config.includes('test-token-never-public'), false)
  assert.equal(JSON.stringify(result).includes('test-token'), false)
  await f.manager.restore(); assert.equal(f.manager.runtimes.size, 1)
  await getDispatcher().dispatch({ channel: 'wechat_shop', accountId: 1, messageType: 'text', content: { text: '人工回复' } })
  assert.equal(f.sent.length, 1); assert.equal(fallback, 0)
  await getDispatcher().dispatch({ channel: 'whatsapp', accountId: 99 })
  assert.equal(fallback, 1)
  const runtime = f.manager.runtimes.get('client-a'); runtime.link.ready = false
  await assert.rejects(getDispatcher().dispatch({ channel: 'wechat_shop', accountId: 1 }), /断开/)
  assert.equal(f.sent.length, 1)
  await f.manager.disconnect('client-a'); assert.equal(f.rows[0].status, 'inactive')
  await assert.rejects(getDispatcher().dispatch({ channel: 'wechat_shop', accountId: 1 }), /尚未连接/)
})

test('inbound private image path is translated without exposing token; new pairing reuses inactive account', async () => {
  setDispatcher({ dispatch: async () => {} })
  const f = fixture(); await f.manager.pair('lwp_' + 'b'.repeat(43))
  const runtime = f.manager.runtimes.get('client-a')
  await runtime.inbound.handle({ payload: { accountId: 1, messageType: 'image', content: { url: '/v1/local-shop/media/cloud-message' } } })
  assert.equal(f.inbound[0].payload.content.url, '/api/v1/local-workbench/media/1/cloud-message')
  await f.manager.disconnect('client-a')
  await f.manager.pair('lwp_' + 'c'.repeat(43))
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].id, 1); assert.equal(f.rows[0].status, 'active')
})

test('invalid code or unavailable local cipher never consumes a remote pairing code', async () => {
  const f = fixture()
  await assert.rejects(f.manager.pair('invalid'), /配对码/)
  assert.equal(f.calls.length, 0)
  f.manager.encrypt = () => { throw new Error('encryption unavailable') }
  await assert.rejects(f.manager.pair('lwp_' + 'a'.repeat(43)), /encryption unavailable/)
  assert.equal(f.calls.length, 0)
})

test('shop detach waits for inbound persistence and removes only its account runtime mapping', async () => {
  const f = fixture(); await f.manager.pair('lwp_' + 'd'.repeat(43))
  const runtime = f.manager.runtimes.get('client-a')
  let complete
  runtime.pendingInbound.add(new Promise(resolve => { complete = resolve }))
  const operation = f.manager.detachAccount(f.rows[0])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.deleting, true)
  assert.equal(f.rows[0].status, 'active')
  complete(); await operation
  assert.equal(f.rows[0].status, 'inactive'); assert.equal(f.manager.byAccount.size, 0)
  assert.ok(f.calls.some(row => row.url.endsWith('/detach') && JSON.parse(row.request.body).installationId === 'shop-a'))
})

test('active sends or remote failure prevent deletion detach and retain usable runtime', async () => {
  const f = fixture(); await f.manager.pair('lwp_' + 'e'.repeat(43))
  const runtime = f.manager.runtimes.get('client-a')
  runtime.pendingOutbound.add(Promise.resolve())
  await assert.rejects(f.manager.detachAccount(f.rows[0]), { status: 409 })
  runtime.pendingOutbound.clear()
  f.manager.remote = async () => { throw new Error('remote unavailable') }
  await assert.rejects(f.manager.detachAccount(f.rows[0]), /remote unavailable/)
  assert.equal(runtime.deleting, false); assert.equal(runtime.link.ready, true)
  assert.equal(f.rows[0].status, 'active')
})


test('图片使用隔离 HTTPS 接口与稳定任务编号，不把二进制塞入 WebSocket',async()=>{
 setDispatcher({dispatch:async()=>{}})
 const f=fixture();await f.manager.pair('lwp_'+'c'.repeat(43))
 f.manager.imageLoader=async id=>{assert.equal(id,12);return {buffer:Buffer.alloc(20,1)}}
 const result=await getDispatcher().dispatch({accountId:1,messageType:'image',localMessageId:'stable-id',targetUserId:'fixture-user',content:{mediaFileId:12}})
 const call=f.calls.at(-1),body=JSON.parse(call.request.body)
 assert.ok(call.url.endsWith('/send-image'));assert.equal(body.installationId,'shop-a');assert.equal(body.requestId,'stable-id');assert.equal(f.sent.length,0)
})
