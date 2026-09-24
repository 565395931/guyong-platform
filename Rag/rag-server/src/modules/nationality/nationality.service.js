const { sequelize } = require('../../config/database')
const { extractPhoneFromChatId, resolveCustomerPhone } = require('../../services/customerPhoneService')

const DICTIONARY_CACHE_TTL_MS = 10 * 60 * 1000

let dictionaryCache = null
let dictionaryCacheExpiresAt = 0

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(String)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function normalizeDictionaryRow(row) {
  return {
    code: row.country_code,
    name: row.name_zh,
    nameEn: row.name_en,
    phonePrefixes: parseJsonArray(row.phone_prefixes),
    languageCodes: parseJsonArray(row.language_codes).map(code => code.toLowerCase()),
    priority: Number(row.inference_priority || 0)
  }
}

async function getNationalityDictionary({ includeInactive = false, refresh = false } = {}) {
  const now = Date.now()
  if (!includeInactive && !refresh && dictionaryCache && now < dictionaryCacheExpiresAt) {
    return dictionaryCache
  }

  const [rows] = await sequelize.query(
    `SELECT country_code, name_zh, name_en, phone_prefixes, language_codes, inference_priority
     FROM nationality_dictionary
     ${includeInactive ? '' : "WHERE status = 'active'"}
     ORDER BY sort_order ASC, name_zh ASC`,
    { replacements: {} }
  )
  const dictionary = rows.map(normalizeDictionaryRow)
  if (!includeInactive) {
    dictionaryCache = dictionary
    dictionaryCacheExpiresAt = now + DICTIONARY_CACHE_TTL_MS
  }
  return dictionary
}

function extractWhatsAppPhone(userId) {
  return extractPhoneFromChatId(userId)
}

function selectNationalityByPhone(phone, dictionary) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return null

  const matches = []
  for (const item of dictionary || []) {
    for (const rawPrefix of item.phonePrefixes || []) {
      const prefix = String(rawPrefix).replace(/\D/g, '')
      if (prefix && digits.startsWith(prefix)) {
        matches.push({ item, prefixLength: prefix.length })
      }
    }
  }
  matches.sort((a, b) => b.prefixLength - a.prefixLength || b.item.priority - a.item.priority)
  return matches[0]?.item || null
}

function selectNationalityByLanguage(languageCode, dictionary) {
  const code = String(languageCode || '').trim().toLowerCase()
  if (!code || code === 'unknown' || code === 'other') return null
  return [...(dictionary || [])]
    .filter(item => item.languageCodes.includes(code))
    .sort((a, b) => b.priority - a.priority)[0] || null
}

function extractLanguageCode(content) {
  if (!content) return null
  let value = content
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value.originalLang) return String(value.originalLang).toLowerCase()
  const text = value.text || value.content || ''
  if (!String(text).trim()) return null
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  return null
}

async function getConversationInferenceInput(conversationId) {
  const [rows] = await sequelize.query(
    `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.nationality_code,
            (SELECT pm.content
             FROM plat_messages pm
             WHERE pm.conversation_id = c.id
               AND pm.direction = 'inbound'
               AND pm.sender_type = 'customer'
               AND pm.message_type = 'text'
             ORDER BY pm.created_at DESC, pm.id DESC
             LIMIT 1) AS latest_content
     FROM conversations c
     WHERE c.id = :conversationId
     LIMIT 1`,
    { replacements: { conversationId } }
  )
  return rows[0] || null
}

async function inferConversationNationality(conversationId, input = null, { force = false } = {}) {
  const conversation = input || await getConversationInferenceInput(conversationId)
  if (!conversation) return { inferred: false, reason: 'conversation_not_found' }
  if (conversation.nationality_code && !force) {
    return { inferred: false, skipped: true, reason: 'nationality_exists', code: conversation.nationality_code }
  }

  const dictionary = await getNationalityDictionary()
  let phone = conversation.channel === 'whatsapp'
    ? extractWhatsAppPhone(conversation.user_id)
    : null
  if (conversation.channel === 'whatsapp' && !phone && /@lid$/i.test(conversation.user_id || '')) {
    const resolvedPhone = await resolveCustomerPhone(conversation)
    phone = resolvedPhone ? String(resolvedPhone).replace(/\D/g, '') : null
  }
  let languageCode = extractLanguageCode(conversation.latest_content || conversation.content)
  if (!phone && !languageCode && input) {
    const storedConversation = await getConversationInferenceInput(conversationId)
    languageCode = extractLanguageCode(storedConversation?.latest_content)
  }
  const phoneMatch = phone ? selectNationalityByPhone(phone, dictionary) : null
  const languageMatch = selectNationalityByLanguage(languageCode, dictionary)
  const match = phoneMatch || languageMatch
  const source = phoneMatch ? 'phone' : 'language'

  if (!match) {
    return { inferred: false, reason: phone ? 'phone_and_language_not_matched' : 'language_not_matched' }
  }

  await sequelize.query(
    `UPDATE conversations
     SET nationality_code = :code,
         nationality_source = :source,
         nationality_inferred_at = NOW(),
         updated_at = NOW()
     WHERE id = :conversationId
       ${force ? '' : "AND (nationality_code IS NULL OR nationality_code = '')"}`,
    { replacements: { code: match.code, source, conversationId } }
  )

  const [savedRows] = await sequelize.query(
    `SELECT c.nationality_code, c.nationality_source, c.nationality_inferred_at,
            nd.name_zh AS nationality_name, nd.name_en AS nationality_name_en
     FROM conversations c
     LEFT JOIN nationality_dictionary nd ON nd.country_code = c.nationality_code
     WHERE c.id = :conversationId
     LIMIT 1`,
    { replacements: { conversationId } }
  )
  const saved = savedRows[0] || null
  return {
    inferred: saved?.nationality_code === match.code,
    data: saved,
    reason: saved?.nationality_code === match.code ? null : 'concurrent_update'
  }
}

async function updateConversationNationality(conversationId, nationalityCode) {
  const code = nationalityCode ? String(nationalityCode).trim().toUpperCase() : null
  if (code) {
    const [dictionaryRows] = await sequelize.query(
      `SELECT country_code FROM nationality_dictionary
       WHERE country_code = :code AND status = 'active'
       LIMIT 1`,
      { replacements: { code } }
    )
    if (dictionaryRows.length === 0) {
      const error = new Error('国籍字典中不存在该国家或该项已停用')
      error.statusCode = 400
      throw error
    }
  }

  await sequelize.query(
    `UPDATE conversations
     SET nationality_code = :code,
         nationality_source = ${code ? "'manual'" : 'NULL'},
         nationality_inferred_at = ${code ? 'NOW()' : 'NULL'},
         updated_at = NOW()
     WHERE id = :conversationId`,
    { replacements: { code, conversationId } }
  )

  const [rows] = await sequelize.query(
    `SELECT c.nationality_code, c.nationality_source, c.nationality_inferred_at,
            nd.name_zh AS nationality_name, nd.name_en AS nationality_name_en
     FROM conversations c
     LEFT JOIN nationality_dictionary nd ON nd.country_code = c.nationality_code
     WHERE c.id = :conversationId
     LIMIT 1`,
    { replacements: { conversationId } }
  )
  return rows[0] || null
}

module.exports = {
  getNationalityDictionary,
  extractWhatsAppPhone,
  selectNationalityByPhone,
  selectNationalityByLanguage,
  extractLanguageCode,
  inferConversationNationality,
  updateConversationNationality,
  parseJsonArray
}
