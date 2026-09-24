const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const {
  GATEWAY_URL,
  REQUEST_TIMEOUT_MS,
  callTaobaoApi
} = require('./taobaoClient')
const { buildTaobaoSign } = require('./taobaoSignature')

const credentials = Object.freeze({
  appKey: 'taobao-app-key',
  appSecret: 'taobao-app-secret-sensitive',
  sessionKey: 'taobao-session-sensitive'
})

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    }
  }
}

async function rejectedError(operation) {
  try {
    await operation()
    assert.fail('expected operation to reject')
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error
    return error
  }
}

function assertDoesNotLeak(error, values) {
  const serialized = JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...error
  })
  for (const value of values) {
    assert.equal(serialized.includes(value), false, `error leaked ${value}`)
  }
}

test('builds the official uppercase MD5 signature from sorted TOP parameters', () => {
  const params = {
    v: '2.0',
    timestamp: '2026-07-26 00:05:06',
    sign_method: 'md5',
    session: 'session',
    page_no: 1,
    method: 'taobao.trades.sold.increment.get',
    format: 'json',
    app_key: 'abc'
  }
  const canonical = [
    'app_keyabc',
    'formatjson',
    'methodtaobao.trades.sold.increment.get',
    'page_no1',
    'sessionsession',
    'sign_methodmd5',
    'timestamp2026-07-26 00:05:06',
    'v2.0'
  ].join('')
  const expected = crypto.createHash('md5')
    .update(`secret${canonical}secret`, 'utf8')
    .digest('hex')
    .toUpperCase()

  assert.equal(buildTaobaoSign(params, 'secret'), expected)
})

test('omits nullish values and an existing sign from the signature', () => {
  const expected = crypto.createHash('md5')
    .update('secretenabledfalsepage_no1secret', 'utf8')
    .digest('hex')
    .toUpperCase()

  assert.equal(buildTaobaoSign({
    page_no: 1,
    enabled: false,
    nullable: null,
    missing: undefined,
    sign: 'must-not-participate'
  }, 'secret'), expected)
})

test('posts signed form data with fixed TOP parameters, GMT+8 time and a ten-second timeout', async () => {
  let request
  let timeout
  const expectedSignal = new AbortController().signal
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = milliseconds => {
    timeout = milliseconds
    return expectedSignal
  }

  try {
    const result = await callTaobaoApi(
      'taobao.trades.sold.increment.get',
      {
        start_modified: '2026-07-25 23:00:00',
        end_modified: '2026-07-26 00:00:00',
        nullable: null,
        method: 'must-not-override',
        app_key: 'must-not-override',
        session: 'must-not-override',
        app_secret: 'must-not-be-sent',
        sign: 'must-not-override-generated-sign'
      },
      credentials,
      {
        now: () => Date.UTC(2026, 6, 25, 16, 5, 6),
        fetchImpl: async (url, options) => {
          request = { url, ...options }
          return textResponse({ trades_sold_increment_get_response: { total_results: 0 } })
        }
      }
    )

    const body = new URLSearchParams(request.body)
    const unsigned = Object.fromEntries(body.entries())
    const sign = unsigned.sign
    delete unsigned.sign

    assert.equal(GATEWAY_URL, 'https://eco.taobao.com/router/rest')
    assert.equal(REQUEST_TIMEOUT_MS, 10_000)
    assert.equal(request.url, GATEWAY_URL)
    assert.equal(request.method, 'POST')
    assert.deepEqual(request.headers, {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
    })
    assert.equal(request.signal, expectedSignal)
    assert.equal(timeout, 10_000)
    assert.equal(body.get('method'), 'taobao.trades.sold.increment.get')
    assert.equal(body.get('app_key'), credentials.appKey)
    assert.equal(body.get('session'), credentials.sessionKey)
    assert.equal(body.get('timestamp'), '2026-07-26 00:05:06')
    assert.equal(body.get('v'), '2.0')
    assert.equal(body.get('sign_method'), 'md5')
    assert.equal(body.get('format'), 'json')
    assert.equal(body.get('start_modified'), '2026-07-25 23:00:00')
    assert.equal(body.get('end_modified'), '2026-07-26 00:00:00')
    assert.equal(body.has('nullable'), false)
    assert.equal(body.has('app_secret'), false)
    assert.notEqual(sign, 'must-not-override-generated-sign')
    assert.match(sign, /^[A-F0-9]{32}$/)
    assert.equal(sign, buildTaobaoSign(unsigned, credentials.appSecret))
    assert.deepEqual(result, { trades_sold_increment_get_response: { total_results: 0 } })
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test('parses large TOP identifiers and decimal amounts losslessly while retaining safe integers', async () => {
  const tradeId = '900719925474099312345'
  const itemId = '9223372036854775807123'
  const refundId = '184467440737095516151'
  const rawResponse = `{
    "trades_sold_get_response": {
      "trade": {
        "tid": ${tradeId},
        "num_iid": ${itemId},
        "refund_id": ${refundId},
        "max_safe": 9007199254740991,
        "min_safe": -9007199254740991,
        "payment": 123456789012345.5,
        "quoted_safe": "9007199254740991"
      }
    }
  }`

  const parsed = await callTaobaoApi(
    'taobao.trades.sold.get',
    {},
    credentials,
    { now: () => 0, fetchImpl: async () => textResponse(rawResponse) }
  )
  const trade = parsed.trades_sold_get_response.trade

  assert.equal(trade.tid, tradeId)
  assert.equal(trade.num_iid, itemId)
  assert.equal(trade.refund_id, refundId)
  assert.equal(trade.max_safe, Number.MAX_SAFE_INTEGER)
  assert.equal(typeof trade.max_safe, 'number')
  assert.equal(trade.min_safe, Number.MIN_SAFE_INTEGER)
  assert.equal(typeof trade.min_safe, 'number')
  assert.equal(trade.payment, '123456789012345.5')
  assert.equal(typeof trade.payment, 'string')
  assert.equal(trade.quoted_safe, '9007199254740991')
})

test('maps non-success HTTP responses to stable redacted errors', async () => {
  const responseSign = 'taobao-http-sign-sensitive'
  const error = await rejectedError(() => callTaobaoApi(
    'taobao.trades.sold.get',
    { buyer_nick: 'buyer-parameter-sensitive' },
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => textResponse(
        `${credentials.appSecret}:${credentials.sessionKey}:${responseSign}:buyer-parameter-sensitive`,
        502
      )
    }
  ))

  assert.equal(error.code, 'TAOBAO_HTTP_ERROR')
  assert.equal(error.status, 502)
  assertDoesNotLeak(error, [
    credentials.appSecret,
    credentials.sessionKey,
    responseSign,
    'buyer-parameter-sensitive'
  ])
})

test('maps invalid JSON responses to stable redacted errors', async () => {
  const responseSign = 'taobao-json-sign-sensitive'
  const error = await rejectedError(() => callTaobaoApi(
    'taobao.trades.sold.get',
    {},
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => textResponse(
        `{${credentials.appSecret}:${credentials.sessionKey}:${responseSign}`
      )
    }
  ))

  assert.equal(error.code, 'TAOBAO_INVALID_JSON')
  assertDoesNotLeak(error, [credentials.appSecret, credentials.sessionKey, responseSign])
})

test('maps error_response to a stable error without echoing TOP messages or credentials', async () => {
  const responseSign = 'taobao-api-sign-sensitive'
  const error = await rejectedError(() => callTaobaoApi(
    'taobao.trades.sold.get',
    {},
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => textResponse({
        error_response: {
          code: 27,
          msg: `${credentials.appSecret}:${credentials.sessionKey}:${responseSign}`,
          sub_msg: 'business-parameter-sensitive',
          sign: responseSign
        }
      })
    }
  ))

  assert.equal(error.code, 'TAOBAO_API_ERROR')
  assert.equal(error.apiErrorCode, '27')
  assertDoesNotLeak(error, [
    credentials.appSecret,
    credentials.sessionKey,
    responseSign,
    'business-parameter-sensitive'
  ])
})

test('maps transport failures to stable redacted errors', async () => {
  const requestParameter = 'taobao-transport-parameter-sensitive'
  const error = await rejectedError(() => callTaobaoApi(
    'taobao.trades.sold.get',
    { marker: requestParameter },
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => {
        throw new Error(`${credentials.appSecret}:${credentials.sessionKey}:${requestParameter}`)
      }
    }
  ))

  assert.equal(error.code, 'TAOBAO_NETWORK_ERROR')
  assertDoesNotLeak(error, [credentials.appSecret, credentials.sessionKey, requestParameter])
})
