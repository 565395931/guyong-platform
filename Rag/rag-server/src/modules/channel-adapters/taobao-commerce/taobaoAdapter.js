const BaseAdapter = require('../base')
const { applyCommerceProjectionMapper, attachCommerceProjection } = require('../commerceProjectionMapper')

const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000

function createShapeError(message) {
  const error = new TypeError(`Invalid Taobao event shape: ${message}`)
  error.code = 'taobao_event_shape_invalid'
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
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clonePayload(nested)]))
  }
  return value
}

function requireStableIdentifier(value, field) {
  if (!['string', 'number'].includes(typeof value)) throw createShapeError(`${field} is required`)
  const identifier = String(value).trim()
  if (!identifier) throw createShapeError(`${field} is required`)
  return identifier
}

function validateCalendarParts(match, field) {
  const [, year, month, day, hour, minute, second, fraction = '0'] = match
  const [y, m, d, h, min, sec] = [year, month, day, hour, minute, second].map(Number)
  const milliseconds = Number(fraction.padEnd(3, '0'))
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

function parseTaobaoTime(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw createShapeError(`${field} is required`)
  const raw = value.trim()
  const localMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
  )
  if (localMatch) {
    const { y, m, d, h, min, sec, milliseconds } = validateCalendarParts(localMatch, field)
    return new Date(
      Date.UTC(y, m - 1, d, h, min, sec, milliseconds) - CHINA_OFFSET_MILLISECONDS
    ).toISOString()
  }

  const zonedMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
  )
  if (zonedMatch) {
    validateCalendarParts(zonedMatch, field)
    const normalized = raw.replace(' ', 'T')
    const timestamp = Date.parse(normalized)
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  }
  throw createShapeError(`${field} must be a China time or an explicit timezone timestamp`)
}

class TaobaoCommerceAdapter extends BaseAdapter {
  channel = 'taobao'
  adapterType = 'taobao_commerce'

  constructor({ orderProjectionMapper = null } = {}) {
    super()
    if (orderProjectionMapper !== null && typeof orderProjectionMapper !== 'function') {
      throw new TypeError('orderProjectionMapper must be a function')
    }
    this.orderProjectionMapper = orderProjectionMapper
  }

  normalizeOrder(order, { accountId } = {}) {
    const payload = clonePayload(order)
    const tid = requireStableIdentifier(payload?.tid, 'tid')
    const modified = typeof payload?.modified === 'string' ? payload.modified.trim() : ''
    const occurredAt = parseTaobaoTime(modified, 'modified')
    const event = {
      externalEventId: `order:${tid}:${modified}`,
      channel: this.channel,
      accountId,
      eventType: 'order.updated',
      category: 'order',
      businessKey: tid,
      occurredAt,
      payload
    }
    return this.orderProjectionMapper
      ? applyCommerceProjectionMapper(event, this.orderProjectionMapper)
      : attachCommerceProjection(event)
  }

  normalizeRefund(refund, { accountId } = {}) {
    const payload = clonePayload(refund)
    const refundId = requireStableIdentifier(payload?.refund_id, 'refund_id')
    const modified = typeof payload?.modified === 'string' ? payload.modified.trim() : ''
    const occurredAt = parseTaobaoTime(modified, 'modified')
    const businessKey = payload?.tid == null || payload.tid === ''
      ? refundId
      : requireStableIdentifier(payload.tid, 'tid')
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

  normalizeAfterSale(refund, context = {}) {
    return this.normalizeRefund(refund, context)
  }

  async sendMessage() {
    return {
      success: false,
      code: 'capability_not_supported',
      error: 'Taobao Open Platform does not expose a public server-side API for sending buyer customer-service chat messages.'
    }
  }
}

module.exports = TaobaoCommerceAdapter
