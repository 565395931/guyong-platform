function normalizeShopId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized || null
}

function explicitEventShopIds(event = {}) {
  if (event.category === 'probe') return []
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
  return [...new Set([
    normalizeShopId(payload.shop_id),
    normalizeShopId(payload.shopId)
  ].filter(Boolean))]
}

function verifyDouyinEventShopScope(events = [], configuredShopId) {
  const expectedShopId = normalizeShopId(configuredShopId)
  for (const event of events) {
    for (const eventShopId of explicitEventShopIds(event)) {
      if (!expectedShopId || eventShopId !== expectedShopId) {
        const error = new Error('抖店事件与账号店铺范围不一致')
        error.code = 'douyin_shop_id_mismatch'
        throw error
      }
    }
  }
  return true
}

module.exports = { verifyDouyinEventShopScope }
