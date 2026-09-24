const BaseAdapter = require('../base')
const { applyCommerceProjectionMapper, attachCommerceProjection } = require('../commerceProjectionMapper')

const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000

function createShapeError(message) {
  const error = new TypeError(`Invalid Pinduoduo event shape: ${message}`)
  error.code = 'pinduoduo_event_shape_invalid'
  return error
}

function clonePayload(value) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw createShapeError('payload contains a non-finite number')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw createShapeError('payload contains an unsafe integer; identifiers must be strings')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(clonePayload)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePayload(item)]))
  }
  return value
}

function requireStableIdentifier(value, field) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw createShapeError(`${field} is an unsafe integer; provide it as a string`)
  }
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    throw createShapeError(`${field} is required`)
  }

  const identifier = String(value).trim()
  if (!identifier) throw createShapeError(`${field} is required`)
  return identifier
}

function parseChinaTime(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createShapeError(`${field} is required`)
  }

  const raw = value.trim()
  const localMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
  )

  if (localMatch) {
    const [, year, month, day, hour, minute, second, fraction = '0'] = localMatch
    const parts = [year, month, day, hour, minute, second].map(Number)
    const milliseconds = Number(fraction.padEnd(3, '0'))
    const [y, m, d, h, min, sec] = parts
    const utcMilliseconds = Date.UTC(y, m - 1, d, h, min, sec, milliseconds) - CHINA_OFFSET_MILLISECONDS
    const chinaParts = new Date(utcMilliseconds + CHINA_OFFSET_MILLISECONDS)

    const isValid = chinaParts.getUTCFullYear() === y &&
      chinaParts.getUTCMonth() === m - 1 &&
      chinaParts.getUTCDate() === d &&
      chinaParts.getUTCHours() === h &&
      chinaParts.getUTCMinutes() === min &&
      chinaParts.getUTCSeconds() === sec
    if (!isValid) throw createShapeError(`${field} is not a valid China time`)

    return new Date(utcMilliseconds).toISOString()
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const timestamp = Date.parse(raw)
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  }

  throw createShapeError(`${field} must be an explicit timestamp or a China time string`)
}

class PinduoduoCommerceAdapter extends BaseAdapter {
  channel = 'pinduoduo'
  adapterType = 'pinduoduo_commerce'

  constructor({ orderProjectionMapper = null } = {}) {
    super()
    if (orderProjectionMapper !== null && typeof orderProjectionMapper !== 'function') {
      throw new TypeError('orderProjectionMapper must be a function')
    }
    this.orderProjectionMapper = orderProjectionMapper
  }

  normalizeOrder(order, { accountId } = {}) {
    const payload = clonePayload(order)
    const orderSn = requireStableIdentifier(payload?.order_sn, 'order_sn')
    const updatedAt = typeof payload?.updated_at === 'string' ? payload.updated_at.trim() : ''
    const occurredAt = parseChinaTime(updatedAt, 'updated_at')

    const event = {
      externalEventId: `order:${orderSn}:${updatedAt}`,
      channel: this.channel,
      accountId,
      eventType: 'order.updated',
      category: 'order',
      businessKey: orderSn,
      occurredAt,
      payload
    }
    return this.orderProjectionMapper
      ? applyCommerceProjectionMapper(event, this.orderProjectionMapper)
      : attachCommerceProjection(event)
  }

  normalizeAfterSale(refund, { accountId } = {}) {
    const payload = clonePayload(refund)
    const refundId = requireStableIdentifier(payload?.id, 'id')
    const hasUpdatedTime = typeof payload?.updated_time === 'string' && payload.updated_time.trim()
    const updateField = hasUpdatedTime ? 'updated_time' : 'updated_at'
    const updatedTime = typeof payload?.[updateField] === 'string' ? payload[updateField].trim() : ''
    const occurredAt = parseChinaTime(updatedTime, updateField)
    const businessKey = payload.order_sn === undefined || payload.order_sn === null || payload.order_sn === ''
      ? refundId
      : requireStableIdentifier(payload.order_sn, 'order_sn')

    return {
      externalEventId: `after_sales:${refundId}:${updatedTime}`,
      channel: this.channel,
      accountId,
      eventType: 'after_sales.updated',
      category: 'after_sales',
      businessKey,
      occurredAt,
      payload
    }
  }

  async receiveEvent() {
    return []
  }

  async sendMessage() {
    return {
      success: false,
      code: 'capability_not_supported',
      error: '拼多多官方商家 API 不提供买家客服聊天消息收发能力'
    }
  }

  async bindAccount() {
    return { success: true }
  }

  async unbindAccount() {
    return { success: true }
  }
}

module.exports = PinduoduoCommerceAdapter
