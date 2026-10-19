const crypto = require('crypto')
function fail(message, code = 'shop_order_invalid') { throw Object.assign(new Error(message), { code }) }
function orderId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('订单编号精度无效，请使用字符串')
  const id = String(value ?? '')
  if (!/^[0-9]{1,64}$/.test(id)) fail('订单编号无效')
  return id
}
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : ''
function summary(order, openId) {
  // Forwarded cards do not prove ownership; a gift giver is not its recipient.
  const relationship = order.openid === openId ? (order.is_present ? 'gift_recipient' : 'buyer') : order.is_present && order.present_giver_openid === openId ? 'gift_giver' : null
  if (!relationship) fail('该订单未确认属于当前客户，不显示订单详情', 'shop_order_unrelated')
  const detail = order.order_detail || {}
  return { orderId: orderId(order.order_id), relationship, status: Number.isInteger(order.status) ? order.status : null,
    createdAt: Number.isSafeInteger(order.create_time) && order.create_time >= 0 && order.create_time < 253402300800 ? new Date(order.create_time * 1000).toISOString() : null,
    totalFen: Number.isSafeInteger(detail.price_info?.order_price) && detail.price_info.order_price >= 0 ? detail.price_info.order_price : null,
    products: (Array.isArray(detail.product_infos) ? detail.product_infos : []).slice(0, 30).map(product => ({ title: text(product.title, 300), quantity: Number.isSafeInteger(product.sku_cnt) ? product.sku_cnt : null,
      attributes: (Array.isArray(product.sku_attrs) ? product.sku_attrs : []).slice(0, 10).map(attr => ({ name: text(attr.attr_key, 80), value: text(attr.attr_value, 100) })) })),
    // Documented only for specific toy orders; never overwrite the customer remark.
    ...(relationship !== 'gift_giver' && order.user_info?.nickname ? { orderUser: { nickname: text(order.user_info.nickname, 100), source: 'order_user_info' } } : {}) }
}
class ShopCustomerOrders {
  constructor({ store, cipher, shop, now = () => Date.now() }) { Object.assign(this, { store, cipher, shop, now }) }
  async context(conversationId) {
    const data = await this.store.snapshot()
    const conversation = data.conversations.find(row => row.id === conversationId && row.channel === 'wechat_shop')
    const installation = data.shopInstallations.find(row => row.id === conversation?.installationId && row.tenantId === conversation.tenantId)
    if (!installation || installation.appId !== conversation.openKfId) fail('小店会话不存在或账号归属已变更', 'conversation_not_found')
    return { conversation, installation, data }
  }
  async list(conversationId, input = {}, actorId) {
    const { conversation, installation, data } = await this.context(conversationId)
    const endTime = Math.floor(this.now() / 1000)
    let query = { startTime: endTime - 7 * 86400, endTime, nextKey: '' }
    if (input.cursor) {
      try {
        const decoded = JSON.parse(this.cipher.decrypt(input.cursor))
        if (decoded.conversationId !== conversationId || decoded.installationId !== installation.id || decoded.tenantId !== installation.tenantId || decoded.openId !== conversation.externalUserId || decoded.expiresAt <= this.now()) throw new Error()
        query = decoded.query
      } catch { fail('订单分页已过期，请重新查询') }
    }
    const accessToken = await this.shop.accessToken(installation.id)
    const result = await this.shop.client.listOrders({ accessToken, openId: conversation.externalUserId, ...query })
    if (!Array.isArray(result.order_id_list) || result.order_id_list.length > 20) fail('小店订单列表响应无效')
    const ids = result.order_id_list.map(orderId)
    const cardIds = input.cursor ? [] : data.messages.filter(row => row.conversationId === conversationId && row.direction === 'inbound' && row.shopDetails?.orderId).slice(-10).map(row => row.shopDetails.orderId).filter(id => /^[0-9]{1,64}$/.test(id))
    const targets = [...new Set([...ids, ...cardIds])]
    const orders = []; let unavailableCount = 0; let unrelatedCount = 0
    for (let offset = 0; offset < targets.length; offset += 5) {
      await Promise.all(targets.slice(offset, offset + 5).map(async id => {
        try {
          const response = await this.shop.client.getOrder({ accessToken, orderId: id })
          if (!response.order || orderId(response.order.order_id) !== id) fail('订单详情响应无效')
          orders.push(summary(response.order, conversation.externalUserId))
        } catch (error) { if (error.code === 'shop_order_unrelated') unrelatedCount++; else unavailableCount++ }
      }))
    }
    if (result.has_more && (typeof result.next_key !== 'string' || !result.next_key || result.next_key === query.nextKey || result.next_key.length > 4096)) fail('小店订单分页响应无效')
    const cursor = result.has_more ? this.cipher.encrypt(JSON.stringify({ conversationId, installationId: installation.id, tenantId: installation.tenantId, openId: conversation.externalUserId, query: { ...query, nextKey: result.next_key }, expiresAt: this.now() + 15 * 60 * 1000 })) : null
    await this.store.transaction(current => { current.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'customer.orders_read', targetType: 'conversation', targetId: conversationId, metadata: { returned: orders.length, unavailableCount, unrelatedCount }, createdAt: new Date(this.now()).toISOString() }) })
    return { orders: orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), cursor, unavailableCount, unrelatedCount, range: { startTime: query.startTime, endTime: query.endTime }, includesSharedCards: !input.cursor }
  }
}
module.exports = { ShopCustomerOrders, summary, orderId }
