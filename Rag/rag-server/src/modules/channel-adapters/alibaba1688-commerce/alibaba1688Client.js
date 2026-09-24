const createJSONBig = require('json-bigint')
const {
  buildAlibaba1688Signature,
  compactAlibaba1688Params,
  serializeAlibaba1688Value
} = require('./alibaba1688Signature')

const GATEWAY_ORIGIN = 'https://gw.open.1688.com/openapi'
const REQUEST_TIMEOUT_MS = 10_000
const ORDER_LIST_API = 'alibaba.trade.ec.getOrderList.sellerView'
const REFUND_LIST_API = 'alibaba.trade.refund.queryOrderRefundList'
const API_NAMESPACE = 'com.alibaba.trade'
const API_VERSION = '1'
const JSONBigTyped = createJSONBig({ alwaysParseAsBig: true })
const APPROVED_APIS = new Set([ORDER_LIST_API, REFUND_LIST_API])
const RESERVED_BUSINESS_PARAMS = new Set([
  'access_token',
  '_aop_signature',
  'appKey',
  'appSecret',
  'namespace',
  'apiName',
  'version',
  'host',
  'url'
])

function clientError(code, message, safeDetails = {}) {
  const error = new Error(message)
  error.name = 'Alibaba1688ClientError'
  error.code = code
  Object.assign(error, safeDetails)
  return error
}

function requireCredentials(credentials) {
  const source = credentials && typeof credentials === 'object' ? credentials : {}
  const fields = ['appKey', 'appSecret', 'accessToken']
  const missing = fields.filter(field => typeof source[field] !== 'string' || !source[field].trim())
  if (missing.length) {
    throw clientError(
      'ALIBABA1688_CREDENTIALS_INVALID',
      `1688 credentials are incomplete: ${missing.join(', ')}`
    )
  }
  return Object.fromEntries(fields.map(field => [field, source[field].trim()]))
}

function cleanBusinessParams(businessParams) {
  if (businessParams === undefined) return {}
  if (!businessParams || typeof businessParams !== 'object' || Array.isArray(businessParams)) {
    throw clientError('ALIBABA1688_PARAMS_INVALID', '1688 business parameters must be an object')
  }
  return Object.fromEntries(
    Object.entries(businessParams).filter(([key]) => !RESERVED_BUSINESS_PARAMS.has(key))
  )
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

function safeApiErrorCode(payload) {
  const value = payload?.errorCode ?? payload?.error_code ?? payload?.code
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value)) return value
  return undefined
}

async function parseAlibaba1688Response(response) {
  if (!response || typeof response.status !== 'number') {
    throw clientError('ALIBABA1688_NETWORK_ERROR', '1688 gateway returned no valid response')
  }
  if (!response.ok) {
    throw clientError(
      'ALIBABA1688_HTTP_ERROR',
      '1688 gateway returned an unsuccessful HTTP status',
      { status: response.status }
    )
  }

  let rawBody
  try {
    rawBody = await response.text()
  } catch {
    throw clientError('ALIBABA1688_NETWORK_ERROR', 'Unable to read the 1688 gateway response')
  }

  let payload
  try {
    payload = restoreJsonNumberTypes(JSONBigTyped.parse(rawBody))
  } catch {
    throw clientError('ALIBABA1688_INVALID_JSON', '1688 gateway returned invalid JSON')
  }

  if (payload && typeof payload === 'object' && (
    payload.success === false ||
    payload.error ||
    payload.errorCode !== undefined ||
    payload.error_code !== undefined
  )) {
    const apiErrorCode = safeApiErrorCode(payload)
    throw clientError(
      'ALIBABA1688_API_ERROR',
      '1688 API rejected the request',
      apiErrorCode ? { apiErrorCode } : {}
    )
  }
  return payload
}

async function callAlibaba1688Api(
  apiName,
  businessParams,
  credentials,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (!APPROVED_APIS.has(apiName)) {
    throw clientError('ALIBABA1688_API_NOT_ALLOWED', '1688 API is not in the approved whitelist')
  }
  if (typeof fetchImpl !== 'function') {
    throw clientError('ALIBABA1688_CLIENT_CONFIG_INVALID', '1688 client dependencies are invalid')
  }

  const normalizedCredentials = requireCredentials(credentials)
  const path = `param2/${API_VERSION}/${API_NAMESPACE}/${apiName}/${normalizedCredentials.appKey}`
  const params = compactAlibaba1688Params({
    ...cleanBusinessParams(businessParams),
    access_token: normalizedCredentials.accessToken
  })
  params._aop_signature = buildAlibaba1688Signature(
    path,
    params,
    normalizedCredentials.appSecret
  )

  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    form.set(key, serializeAlibaba1688Value(value))
  }

  let response
  try {
    response = await fetchImpl(`${GATEWAY_ORIGIN}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError'
    throw clientError(
      timedOut ? 'ALIBABA1688_TIMEOUT' : 'ALIBABA1688_NETWORK_ERROR',
      timedOut ? '1688 gateway request timed out' : '1688 gateway request failed'
    )
  }

  return parseAlibaba1688Response(response)
}

module.exports = {
  GATEWAY_ORIGIN,
  REQUEST_TIMEOUT_MS,
  ORDER_LIST_API,
  REFUND_LIST_API,
  callAlibaba1688Api,
  parseAlibaba1688Response
}
