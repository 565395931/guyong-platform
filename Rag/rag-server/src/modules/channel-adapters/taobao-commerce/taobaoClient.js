const createJSONBig = require('json-bigint')
const {
  buildTaobaoSign,
  compactTaobaoParams,
  serializeValue
} = require('./taobaoSignature')

const GATEWAY_URL = 'https://eco.taobao.com/router/rest'
const REQUEST_TIMEOUT_MS = 10_000
const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000
const JSONBigTyped = createJSONBig({ alwaysParseAsBig: true })
const RESERVED_BUSINESS_PARAMS = new Set([
  'method',
  'app_key',
  'app_secret',
  'session',
  'timestamp',
  'v',
  'sign_method',
  'format',
  'sign'
])

function clientError(code, message, safeDetails = {}) {
  const error = new Error(message)
  error.name = 'TaobaoClientError'
  error.code = code
  Object.assign(error, safeDetails)
  return error
}

function requireCredentials(credentials) {
  const source = credentials && typeof credentials === 'object' ? credentials : {}
  const fields = ['appKey', 'appSecret', 'sessionKey']
  const missing = fields.filter(field => typeof source[field] !== 'string' || !source[field].trim())
  if (missing.length) {
    throw clientError(
      'TAOBAO_CREDENTIALS_INVALID',
      `Taobao credentials are incomplete: ${missing.join(', ')}`
    )
  }
  return Object.fromEntries(fields.map(field => [field, source[field].trim()]))
}

function cleanBusinessParams(businessParams) {
  if (businessParams === undefined) return {}
  if (!businessParams || typeof businessParams !== 'object' || Array.isArray(businessParams)) {
    throw clientError('TAOBAO_PARAMS_INVALID', 'Taobao business parameters must be an object')
  }
  return Object.fromEntries(
    Object.entries(businessParams).filter(([key]) => !RESERVED_BUSINESS_PARAMS.has(key))
  )
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatChinaTimestamp(nowValue) {
  const milliseconds = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue)
  if (!Number.isFinite(milliseconds)) {
    throw clientError('TAOBAO_TIME_INVALID', 'Taobao request time is invalid')
  }
  const chinaTime = new Date(milliseconds + CHINA_OFFSET_MILLISECONDS)
  return [
    `${chinaTime.getUTCFullYear()}-${pad(chinaTime.getUTCMonth() + 1)}-${pad(chinaTime.getUTCDate())}`,
    `${pad(chinaTime.getUTCHours())}:${pad(chinaTime.getUTCMinutes())}:${pad(chinaTime.getUTCSeconds())}`
  ].join(' ')
}

function restoreJsonNumberTypes(typedValue) {
  if (typedValue && typeof typedValue.isInteger === 'function') {
    if (!typedValue.isInteger()) return typedValue.toFixed()
    if (typedValue.abs().isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) {
      return typedValue.toNumber()
    }
    return typedValue.toFixed()
  }
  if (Array.isArray(typedValue)) {
    return typedValue.map(item => restoreJsonNumberTypes(item))
  }
  if (typedValue && typeof typedValue === 'object') {
    return Object.fromEntries(
      Object.entries(typedValue).map(([key, item]) => [key, restoreJsonNumberTypes(item)])
    )
  }
  return typedValue
}

function safeApiErrorCode(errorResponse) {
  const value = errorResponse?.code
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value
  return undefined
}

async function parseTaobaoResponse(response) {
  if (!response || typeof response.status !== 'number') {
    throw clientError('TAOBAO_NETWORK_ERROR', 'Taobao gateway returned no valid response')
  }
  if (!response.ok) {
    throw clientError(
      'TAOBAO_HTTP_ERROR',
      'Taobao gateway returned an unsuccessful HTTP status',
      { status: response.status }
    )
  }

  let rawBody
  try {
    rawBody = await response.text()
  } catch {
    throw clientError('TAOBAO_NETWORK_ERROR', 'Unable to read the Taobao gateway response')
  }

  let payload
  try {
    payload = restoreJsonNumberTypes(JSONBigTyped.parse(rawBody))
  } catch {
    throw clientError('TAOBAO_INVALID_JSON', 'Taobao gateway returned invalid JSON')
  }

  if (payload && typeof payload === 'object' && payload.error_response) {
    const apiErrorCode = safeApiErrorCode(payload.error_response)
    throw clientError(
      'TAOBAO_API_ERROR',
      'Taobao API rejected the request',
      apiErrorCode ? { apiErrorCode } : {}
    )
  }
  return payload
}

async function callTaobaoApi(
  method,
  businessParams,
  credentials,
  { fetchImpl = globalThis.fetch, now = Date.now } = {}
) {
  if (typeof method !== 'string' || !method.trim()) {
    throw clientError('TAOBAO_METHOD_INVALID', 'Taobao API method is required')
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw clientError('TAOBAO_CLIENT_CONFIG_INVALID', 'Taobao client dependencies are invalid')
  }

  const normalizedCredentials = requireCredentials(credentials)
  const params = compactTaobaoParams({
    ...cleanBusinessParams(businessParams),
    method: method.trim(),
    app_key: normalizedCredentials.appKey,
    session: normalizedCredentials.sessionKey,
    timestamp: formatChinaTimestamp(now()),
    v: '2.0',
    sign_method: 'md5',
    format: 'json'
  })
  params.sign = buildTaobaoSign(params, normalizedCredentials.appSecret)

  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) form.set(key, serializeValue(value))

  let response
  try {
    response = await fetchImpl(GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError'
    throw clientError(
      timedOut ? 'TAOBAO_TIMEOUT' : 'TAOBAO_NETWORK_ERROR',
      timedOut ? 'Taobao gateway request timed out' : 'Taobao gateway request failed'
    )
  }

  return parseTaobaoResponse(response)
}

module.exports = {
  GATEWAY_URL,
  REQUEST_TIMEOUT_MS,
  callTaobaoApi,
  parseTaobaoResponse
}
