// Disposable local UI preview. All platform/model calls are mocked; no live data.
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createControlPlane } = require('../src/saas/controlPlaneServer')
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-ui-preview-'))
  const control = createControlPlane({ env: {
    CONTROL_PLANE_STORE_PATH: path.join(directory, 'data.json'), CONTROL_PLANE_SESSION_SECRET: 'fixture-session-secret'.repeat(3),
    CONTROL_PLANE_DATA_KEY: Buffer.alloc(32, 4).toString('base64'), CONTROL_PLANE_ADMIN_PASSWORD: 'preview-password', CONTROL_PLANE_ADMIN_MUST_CHANGE_PASSWORD: 'false'
  }, wechatShopClient: {
    getToken: async () => ({ accessToken: 'fixture-token', expiresIn: 7200 }),
    listOrders: async () => ({ order_id_list: ['123456789012345678'], has_more: false }),
    getOrder: async ({ orderId }) => ({ order: { order_id: orderId, openid: 'preview-buyer', status: 20, create_time: Math.floor(Date.now() / 1000), order_detail: { price_info: { order_price: 26800 }, product_infos: [{ title: '汽车隔热膜', sku_cnt: 1, sku_attrs: [{ attr_key: '型号', attr_value: '前挡膜' }] }] } } }),
    sendText: async () => { throw new Error('preview never sends') }
  } })
  await control.ready
  await control.store.transaction(data => { data.tenants.push({ id: 'preview-tenant', name: '模拟客户', slug: 'preview', status: 'active' }); data.shopInstallations.push({ id: 'preview-shop', tenantId: 'preview-tenant', name: '模拟店铺', appId: 'wx-preview' }) })
  await control.messaging.ingestInbound({ channel: 'wechat_shop', shopInstallationId: 'preview-shop', openKfId: 'wx-preview', externalUserId: 'preview-buyer', channelMessageId: 'preview-msg', text: '想了解汽车隔热膜，我发送了一个订单卡片。', shopDetails: { orderId: '123456789012345678' } })
  const server = http.createServer(control.handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8795, '127.0.0.1', resolve) })
  console.log('Disposable mock preview: http://127.0.0.1:8795/?surface=admin (admin / preview-password)')
  const stop = () => server.close(() => { fs.rmSync(directory, { recursive: true, force: true }); process.exit(0) })
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  setTimeout(stop, 10 * 60 * 1000)
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1 })
