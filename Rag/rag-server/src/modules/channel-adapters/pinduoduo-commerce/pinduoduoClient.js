const {
  buildPinduoduoSign,
  compactPinduoduoParams
} = require('./pinduoduoSignature')
const createJSONBig = require('json-bigint')

const JSONBigTyped = createJSONBig({ alwaysParseAsBig: true })

const GATEWAY_URL = 'https://gw-api.pinduoduo.com/api/router'
const REQUEST_TIMEOUT_MS = 10_000
const RESERVED_BUSINESS_PARAMS = new Set([
  'type',
  'client_id',
  'client_secret',
  'access_token',
  'data_type',
  'timestamp',
  'sign'
])

function clientError(code, message, safeDetails = {}) {
  const error = new Error(message)
  error.name = 'PinduoduoClientError'
  error.code = code
  Object.assign(error, safeDetails)
  return error
}

function requireCredentials(credentials) {
  const source = credentials && typeof credentials === 'object' ? credentials : {}
  const fields = ['clientId', 'clientSecret', 'accessToken']
  const missing = fields.filter(field => typeof source[field] !== 'string' || !source[field].trim())
  if (missing.length) {
    throw clientError(
      'PINDUODUO_CREDENTIALS_INVALID',
      `Pinduoduo credentials are incomplete: ${missing.join(', ')}`
    )
  }
  return Object.fromEntries(fields.map(field => [field, source[field].trim()]))
}

function cleanBusinessParams(businessParams) {
  if (businessParams === undefined) return {}
  if (!businessParams || typeof businessParams !== 'object' || Array.isArray(businessParams)) {
    throw clientError('PINDUODUO_PARAMS_INVALID', 'Pinduoduo business parameters must be an object')
  }
  return Object.fromEntries(
    Object.entries(businessParams).filter(([key]) => !RESERVED_BUSINESS_PARAMS.has(key))
  )
}

function safeApiErrorCode(errorResponse) {
  const value = errorResponse?.error_code
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value
  return undefined
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

async function parsePinduoduoResponse(response) {
  if (!response || typeof response.status !== 'number') {
    throw clientError('PINDUODUO_NETWORK_ERROR', 'Pinduoduo gateway returned no valid response')
  }
  if (!response.ok) {
    throw clientError(
      'PINDUODUO_HTTP_ERROR',
      'Pinduoduo gateway returned an unsuccessful HTTP status',
      { status: response.status }
    )
  }

  let rawBody
  try {
    rawBody = await response.text()
  } catch {
    throw clientError('PINDUODUO_NETWORK_ERROR', 'Unable to read the Pinduoduo gateway response')
  }

  let payload
  try {
    payload = restoreJsonNumberTypes(JSONBigTyped.parse(rawBody))
  } catch {
    throw clientError('PINDUODUO_INVALID_JSON', 'Pinduoduo gateway returned invalid JSON')
  }

  if (payload && typeof payload === 'object' && payload.error_response) {
    const apiErrorCode = safeApiErrorCode(payload.error_response)
    throw clientError(
      'PINDUODUO_API_ERROR',
      'Pinduoduo API rejected the request',
      apiErrorCode ? { apiErrorCode } : {}
    )
  }
  return payload
}

async function callPinduoduoApi(
  type,
  businessParams,
  credentials,
  { fetchImpl = globalThis.fetch, now = Date.now } = {}
) {
  if (typeof type !== 'string' || !type.trim()) {
    throw clientError('PINDUODUO_TYPE_INVALID', 'Pinduoduo API type is required')
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw clientError('PINDUODUO_CLIENT_CONFIG_INVALID', 'Pinduoduo client dependencies are invalid')
  }

  const normalizedCredentials = requireCredentials(credentials)
  const body = compactPinduoduoParams({
    ...cleanBusinessParams(businessParams),
    type: type.trim(),
    client_id: normalizedCredentials.clientId,
    access_token: normalizedCredentials.accessToken,
    data_type: 'JSON',
    timestamp: Math.floor(now() / 1000)
  })
  body.sign = buildPinduoduoSign(body, normalizedCredentials.clientSecret)

  let response
  try {
    response = await fetchImpl(GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError'
    throw clientError(
      timedOut ? 'PINDUODUO_TIMEOUT' : 'PINDUODUO_NETWORK_ERROR',
      timedOut ? 'Pinduoduo gateway request timed out' : 'Pinduoduo gateway request failed'
    )
  }

  return parsePinduoduoResponse(response)
}

module.exports = {
  GATEWAY_URL,
  REQUEST_TIMEOUT_MS,
  callPinduoduoApi,
  parsePinduoduoResponse
}
