const BaseAdapter = require('../base')
const { applyCommerceProjectionMapper, attachCommerceProjection } = require('../commerceProjectionMapper')

const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000
const PRIVATE_KEY_FRAGMENTS = Object.freeze([
  'phone',
  'mobile',
  'telephone',
  'address',
  'contact',
  'receiver',
  'consignee',
  'realname',
  'loginid',
  'alipayid',
  'alipayaccount',
  'memo',
  'remark',
  'feedback'
])

function createShapeError(message) {
  const error = new TypeError(`Invalid 1688 event shape: ${message}`)
  error.code = 'alibaba1688_event_shape_invalid'
  return error
}

function normalizedKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function isPrivateKey(key) {
  const normalized = normalizedKey(key)
  if (normalized === 'buyeropenuid') return false
  return PRIVATE_KEY_FRAGMENTS.some(fragment => normalized.includes(fragment))
}

function sanitizePayload(value) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw createShapeError('payload contains a non-finite number')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw createShapeError('payload contains an unsafe integer; identifiers must be strings')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(sanitizePayload)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isPrivateKey(key))
        .map(([key, nested]) => [key, sanitizePayload(nested)])
    )
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

function validateCalendarParts(parts, field) {
  const [year, month, day, hour, minute, second, fraction = '0'] = parts
  const [y, m, d, h, min, sec] = [year, month, day, hour, minute, second].map(Number)
  const milliseconds = Number(String(fraction).padEnd(3, '0'))
  const calendar = new Date(Date.UTC(y, m - 1, d, h, min, sec, milliseconds))
  const valid = calendar.getUTCFullYear() === y &&
    calendar.getUTCMonth() === m - 1 &&
    calendar.getUTCDate() === d &&
    calendar.getUTCHours() === h &&
    calendar.getUTCMinutes() === min &&
    calendar.getUTCSeconds() === sec
  if (!valid) throw createShapeError(`${field} is not a valid calendar timestamp`)
  return { y, m, d, h, min, sec, milliseconds }
}

function parseOffset(offset, field) {
  const match = offset.match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!match) throw createShapeError(`${field} has an invalid timezone offset`)
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 23 || minutes > 59) throw createShapeError(`${field} has an invalid timezone offset`)
  const value = (hours * 60 + minutes) * 60 * 1000
  return match[1] === '+' ? value : -value
}

function parseAlibaba1688Time(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw createShapeError(`${field} is required`)
  const raw = value.trim()

  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})([+-]\d{4})$/)
  if (compact) {
    const parts = compact.slice(1, 8)
    const calendar = validateCalendarParts(parts, field)
    const offset = parseOffset(compact[8], field)
    return new Date(Date.UTC(
      calendar.y,
      calendar.m - 1,
      calendar.d,
      calendar.h,
      calendar.min,
      calendar.sec,
      calendar.milliseconds
    ) - offset).toISOString()
  }

  const local = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (local) {
    const calendar = validateCalendarParts(local.slice(1), field)
    return new Date(Date.UTC(
      calendar.y,
      calendar.m - 1,
      calendar.d,
      calendar.h,
      calendar.min,
      calendar.sec,
      calendar.milliseconds
    ) - CHINA_OFFSET_MILLISECONDS).toISOString()
  }

  const zoned = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/)
  if (zoned) {
    validateCalendarParts(zoned.slice(1, 8), field)
    if (zoned[8] !== 'Z') parseOffset(zoned[8], field)
    const timestamp = Date.parse(raw.replace(' ', 'T'))
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  }

  throw createShapeError(`${field} must be a 1688 timestamp, China time or explicit timezone timestamp`)
}

function orderPayloadSource(order) {
  const baseInfo = order?.baseInfo
  if (!baseInfo || typeof baseInfo !== 'object' || Array.isArray(baseInfo) || !baseInfo.idOfStr) {
    return order
  }
  const { id, ...stableBaseInfo } = baseInfo
  return { ...order, baseInfo: stableBaseInfo }
}

class Alibaba1688CommerceAdapter extends BaseAdapter {
  channel = 'alibaba1688'
  adapterType = 'alibaba1688_commerce'

  constructor({ orderProjectionMapper = null } = {}) {
    super()
    if (orderProjectionMapper !== null && typeof orderProjectionMapper !== 'function') {
      throw new TypeError('orderProjectionMapper must be a function')
    }
    this.orderProjectionMapper = orderProjectionMapper
  }

  normalizeOrder(order, { accountId } = {}) {
    const rawBaseInfo = order?.baseInfo
    const orderIdValue = rawBaseInfo?.idOfStr || rawBaseInfo?.id
    const orderId = requireStableIdentifier(orderIdValue, 'baseInfo.idOfStr')
    const modifyTime = typeof rawBaseInfo?.modifyTime === 'string' ? rawBaseInfo.modifyTime.trim() : ''
    const occurredAt = parseAlibaba1688Time(modifyTime, 'baseInfo.modifyTime')
    const payload = sanitizePayload(orderPayloadSource(order))

    const event = {
      externalEventId: `order:${orderId}:${modifyTime}`,
      channel: this.channel,
      accountId,
      eventType: 'order.updated',
      category: 'order',
      businessKey: orderId,
      occurredAt,
      payload
    }
    return this.orderProjectionMapper
      ? applyCommerceProjectionMapper(event, this.orderProjectionMapper)
      : attachCommerceProjection(event)
  }

  normalizeAfterSale(refund, { accountId } = {}) {
    const payload = sanitizePayload(refund)
    const refundId = requireStableIdentifier(payload?.refundId, 'refundId')
    const modified = typeof payload?.gmtModified === 'string' ? payload.gmtModified.trim() : ''
    const occurredAt = parseAlibaba1688Time(modified, 'gmtModified')
    const businessKey = payload?.orderId == null || payload.orderId === ''
      ? refundId
      : requireStableIdentifier(payload.orderId, 'orderId')

    return {
      externalEventId: `after_sales:${refundId}:${modified}`,
      channel: this.channel,
      accountId,
      eventType: 'after_sales.updated',
      category: 'after_sales',
      businessKey,
      occurredAt,
      payload
    }
  }

  async sendMessage() {
    return {
      success: false,
      code: 'capability_not_supported',
      error: '1688 Open Platform does not expose a public server-side API for sending buyer customer-service chat messages.'
    }
  }
}

module.exports = Alibaba1688CommerceAdapter
