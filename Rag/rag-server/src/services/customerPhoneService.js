const LID_PHONE_CACHE_TTL_MS = 30 * 60 * 1000
const LID_PHONE_FAILURE_CACHE_TTL_MS = 60 * 1000
const LID_PHONE_CACHE_MAX = 2000
const lidPhoneCache = new Map()

function extractPhoneFromChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null
  const trimmed = chatId.trim()
  const cusMatch = trimmed.match(/^(\d+)@c\.us$/)
  if (cusMatch) return cusMatch[1]
  const barePhoneMatch = trimmed.match(/^\d{6,}$/)
  return barePhoneMatch ? trimmed : null
}

function onlyDigits(value) {
  return value ? String(value).replace(/\D/g, '') : ''
}

function isPhoneLikeDisplay(value) {
  if (!value || typeof value !== 'string') return false
  return onlyDigits(value).length >= 6 && /^[+\d\s().-]+$/.test(value.trim())
}

function formatPhoneForDisplay(phone, fallbackDisplay) {
  if (!phone) return null
  const digits = onlyDigits(phone)
  if (fallbackDisplay && isPhoneLikeDisplay(fallbackDisplay) && onlyDigits(fallbackDisplay) === digits) {
    return fallbackDisplay.trim()
  }
  if (/^1\d{10}$/.test(digits)) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return phone
}

function trimLidPhoneCache() {
  if (lidPhoneCache.size <= LID_PHONE_CACHE_MAX) return
  const overflow = lidPhoneCache.size - LID_PHONE_CACHE_MAX
  for (let i = 0; i < overflow; i++) {
    const firstKey = lidPhoneCache.keys().next().value
    if (!firstKey) break
    lidPhoneCache.delete(firstKey)
  }
}

async function resolveCustomerPhone(conversation) {
  const userId = conversation?.user_id
  const directPhone = extractPhoneFromChatId(userId)
  if (directPhone) return formatPhoneForDisplay(directPhone, conversation?.user_name)

  if (!userId || typeof userId !== 'string' || !userId.includes('@lid')) return null

  const cacheKey = `${conversation.account_id || ''}:${userId}`
  const cached = lidPhoneCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.phone
  }

  try {
    const { getWahaClientByAccount } = require('../shared/utils/wahaClient')
    const waha = await getWahaClientByAccount(conversation.account_id)
    if (!waha) return null
    const lid = encodeURIComponent(userId)
    const response = await waha.client.get(`/api/${waha.sessionName}/lids/${lid}`, { timeout: 3000 })
    const pn = response.data?.pn || null
    const phone = formatPhoneForDisplay(extractPhoneFromChatId(pn), conversation?.user_name)
    lidPhoneCache.set(cacheKey, { phone, timestamp: Date.now(), ttl: LID_PHONE_CACHE_TTL_MS })
    trimLidPhoneCache()
    return phone
  } catch (err) {
    console.warn(`[CustomerPhone] LID 手机号解析失败 accountId=${conversation.account_id || 'unknown'}:`, err.message)
    lidPhoneCache.set(cacheKey, { phone: null, timestamp: Date.now(), ttl: LID_PHONE_FAILURE_CACHE_TTL_MS })
    trimLidPhoneCache()
    return null
  }
}

async function attachCustomerPhones(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows
  const cache = new Map()
  await Promise.all(rows.map(async row => {
    const cacheKey = `${row.account_id || ''}:${row.user_id || ''}`
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, resolveCustomerPhone(row))
    }
    row.customer_phone = await cache.get(cacheKey)
  }))
  return rows
}

module.exports = {
  extractPhoneFromChatId,
  formatPhoneForDisplay,
  resolveCustomerPhone,
  attachCustomerPhones
}
