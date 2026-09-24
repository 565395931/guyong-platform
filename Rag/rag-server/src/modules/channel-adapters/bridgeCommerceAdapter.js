const BaseAdapter = require('./base')
const { attachCommerceProjection } = require('./commerceProjectionMapper')

const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000

function createShapeError(channel, message) {
  const error = new TypeError(`Invalid ${channel} event shape: ${message}`)
  error.code = `${channel}_event_shape_invalid`
  return error
}

function clonePayload(value, channel) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw createShapeError(channel, 'payload contains a non-finite number')
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw createShapeError(channel, 'identifiers must be strings when outside the safe integer range')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(item => clonePayload(item, channel))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePayload(item, channel)]))
  }
  return value
}

function readPath(source, path) {
  return path.split('.').reduce((value, key) => value?.[key], source)
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path)
    if (value !== undefined && value !== null && String(value).trim()) return { value, path }
  }
  return { value: undefined, path: paths[0] }
}

function stableIdentifier(value, field, channel) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw createShapeError(channel, `${field} is unsafe; provide it as a string`)
  }
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    throw createShapeError(channel, `${field} is required`)
  }
  const identifier = String(value).trim()
  if (!identifier) throw createShapeError(channel, `${field} is required`)
  return identifier
}

function parseChinaCalendar(raw, field, channel) {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction = '0'] = match
  const [y, m, d, h, min, sec] = [year, month, day, hour, minute, second].map(Number)
  const milliseconds = Number(fraction.padEnd(3, '0'))
  const calendar = new Date(Date.UTC(y, m - 1, d, h, min, sec, milliseconds))
  const valid = calendar.getUTCFullYear() === y && calendar.getUTCMonth() === m - 1 &&
    calendar.getUTCDate() === d && calendar.getUTCHours() === h &&
    calendar.getUTCMinutes() === min && calendar.getUTCSeconds() === sec
  if (!valid) throw createShapeError(channel, `${field} is not a valid timestamp`)
  return new Date(calendar.getTime() - CHINA_OFFSET_MILLISECONDS).toISOString()
}

function parseOccurredAt(value, field, channel) {
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(String(value || '').trim()) ? Number(value) : NaN
  if (Number.isFinite(numeric)) {
    const timestamp = numeric < 1e12 ? numeric * 1000 : numeric
    const date = new Date(timestamp)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }

  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw createShapeError(channel, `${field} is required`)
  const chinaTime = parseChinaCalendar(raw, field, channel)
  if (chinaTime) return chinaTime
  const timestamp = Date.parse(raw.replace(' ', 'T'))
  if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  throw createShapeError(channel, `${field} is not a supported timestamp`)
}

function normalizeEvent(channel, category, payloadValue, config, accountId) {
  const payload = clonePayload(payloadValue, channel)
  const identifier = firstValue(payload, config.idPaths)
  const updated = firstValue(payload, config.timePaths)
  const businessId = stableIdentifier(identifier.value, identifier.path, channel)
  const occurredAt = parseOccurredAt(updated.value, updated.path, channel)
  const rawUpdated = String(updated.value).trim()
  const event = {
    externalEventId: `${category}:${businessId}:${rawUpdated}`,
    channel,
    accountId,
    eventType: `${category}.updated`,
    category,
    businessKey: businessId,
    occurredAt,
    payload
  }
  return category === 'order' ? attachCommerceProjection(event) : event
}

function createBridgeCommerceAdapter({ channel, adapterType, order, afterSales, product }) {
  return class BridgeCommerceAdapter extends BaseAdapter {
    channel = channel
    adapterType = adapterType

    normalizeOrder(payload, { accountId } = {}) {
      return normalizeEvent(channel, 'order', payload, order, accountId)
    }

    normalizeAfterSale(payload, { accountId } = {}) {
      return normalizeEvent(channel, 'after_sales', payload, afterSales, accountId)
    }

    normalizeProduct(payload, { accountId } = {}) {
      return normalizeEvent(channel, 'product', payload, product, accountId)
    }

    async receiveEvent() {
      return []
    }

    async sendMessage() {
      return {
        success: false,
        status: 'bridge_required',
        code: 'desktop_bridge_required',
        transport: 'desktop_bridge',
        error: `${channel} customer-service chat requires an active desktop bridge binding.`
      }
    }

    async bindAccount() {
      return { success: true }
    }

    async unbindAccount() {
      return { success: true }
    }
  }
}

module.exports = { createBridgeCommerceAdapter }
