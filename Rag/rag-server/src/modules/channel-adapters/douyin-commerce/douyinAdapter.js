const BaseAdapter = require('../base')
const JSONbig = require('json-bigint')({ storeAsString: true })
const { verifyEventSignature } = require('./douyinSignature')
const { verifyDouyinEventShopScope } = require('./douyinShopScope')
const { attachCommerceProjection } = require('../commerceProjectionMapper')

function parseData(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data }
  if (typeof data === 'string') {
    try {
      const parsed = JSONbig.parse(data)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      return { value: data }
    }
    return { value: data }
  }
  return { value: data ?? null }
}

function classifyEvent(tag, payload) {
  if (tag === '0') return 'probe'
  if (tag === '100' || payload.p_id || payload.order_id) return 'order'
  if (payload.refund_id || payload.aftersale_id || payload.after_sale_id) return 'after_sales'
  if (payload.product_id || payload.product_id_str) return 'product'
  return 'other'
}

function businessKey(payload) {
  return payload.p_id || payload.order_id || payload.refund_id || payload.aftersale_id ||
    payload.after_sale_id || payload.product_id || payload.product_id_str || null
}

function occurredAt(payload) {
  const timestamp = Number(payload.create_time || payload.update_time || payload.timestamp)
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null
}

class DouyinCommerceAdapter extends BaseAdapter {
  channel = 'douyin'
  adapterType = 'douyin_commerce'

  async receiveEvent() {
    return []
  }

  verifyWebhook({ headers = {}, rawBody, config = {} }) {
    return verifyEventSignature({
      appId: headers['app-id'],
      expectedAppId: config.appKey,
      appSecret: config.appSecret,
      rawBody,
      signature: headers['event-sign']
    })
  }

  receiveBusinessEvents(payload, { accountId } = {}) {
    const events = Array.isArray(payload) ? payload : [payload]
    return events.filter(Boolean).map(event => {
      const tag = String(event.tag ?? '')
      const data = parseData(event.data)
      const category = classifyEvent(tag, data)
      const normalized = {
        externalEventId: String(event.msg_id ?? event.msgId ?? ''),
        channel: this.channel,
        accountId: Number(accountId),
        eventType: category === 'probe' ? 'probe' : `tag:${tag}`,
        category,
        businessKey: businessKey(data),
        occurredAt: occurredAt(data),
        payload: data
      }
      return category === 'order' ? attachCommerceProjection(normalized) : normalized
    })
  }

  verifyBusinessEventScope(events, { config = {} } = {}) {
    return verifyDouyinEventShopScope(events, config.shopId)
  }

  async sendMessage() {
    return {
      success: false,
      error: '抖店开放平台暂未提供飞鸽客服消息发送 API',
      code: 'capability_not_supported'
    }
  }

  async bindAccount() {
    return { success: true }
  }

  async unbindAccount() {
    return { success: true }
  }
}

module.exports = DouyinCommerceAdapter
