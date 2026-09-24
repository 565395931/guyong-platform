const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const {
  GATEWAY_URL,
  REQUEST_TIMEOUT_MS,
  callPinduoduoApi
} = require('./pinduoduoClient')
const { buildPinduoduoSign } = require('./pinduoduoSignature')
const PinduoduoCommerceAdapter = require('./pinduoduoAdapter')

const credentials = Object.freeze({
  clientId: 'client-id',
  clientSecret: 'client-secret-sensitive',
  accessToken: 'access-token-sensitive'
})

function jsonResponse(body, status = 200) {
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

test('builds the official uppercase MD5 signature from sorted parameters', () => {
  const params = {
    type: 'pdd.order.number.list.increment.get',
    client_id: 'abc',
    timestamp: 100
  }
  const expected = crypto.createHash('md5')
    .update('secretclient_idabctimestamp100typepdd.order.number.list.increment.getsecret', 'utf8')
    .digest('hex')
    .toUpperCase()

  assert.equal(buildPinduoduoSign(params, 'secret'), expected)
})

test('omits nullish parameters and serializes nested values deterministically', () => {
  const params = {
    z_payload: {
      z: true,
      a: [{ y: false, x: 2 }, undefined, null],
      ignored: null
    },
    enabled: false,
    missing: undefined,
    empty: null
  }
  const canonical = 'enabledfalsez_payload{"a":[{"x":2,"y":false}],"z":true}'
  const expected = crypto.createHash('md5')
    .update(`secret${canonical}secret`, 'utf8')
    .digest('hex')
    .toUpperCase()

  assert.equal(buildPinduoduoSign(params, 'secret'), expected)
})

test('posts signed JSON to the fixed official gateway with injected time and a ten-second timeout', async () => {
  let request
  let timeout
  const expectedSignal = new AbortController().signal
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = milliseconds => {
    timeout = milliseconds
    return expectedSignal
  }

  try {
    const result = await callPinduoduoApi(
      'pdd.order.number.list.increment.get',
      {
        end_updated_at: 200,
        start_updated_at: 100,
        nullable: null,
        client_secret: 'must-not-be-sent',
        sign: 'must-not-override-generated-sign'
      },
      credentials,
      {
        now: () => 1700000000123,
        fetchImpl: async (url, options) => {
          request = { url, ...options }
          return jsonResponse({ order_number_list_get_response: { order_sn_list: [] } })
        }
      }
    )

    const body = JSON.parse(request.body)
    assert.equal(GATEWAY_URL, 'https://gw-api.pinduoduo.com/api/router')
    assert.equal(REQUEST_TIMEOUT_MS, 10_000)
    assert.equal(request.url, GATEWAY_URL)
    assert.equal(request.method, 'POST')
    assert.deepEqual(request.headers, { 'content-type': 'application/json' })
    assert.equal(request.signal, expectedSignal)
    assert.equal(timeout, 10_000)
    assert.equal(body.type, 'pdd.order.number.list.increment.get')
    assert.equal(body.client_id, credentials.clientId)
    assert.equal(body.access_token, credentials.accessToken)
    assert.equal(body.data_type, 'JSON')
    assert.equal(body.timestamp, 1_700_000_000)
    assert.equal(body.start_updated_at, 100)
    assert.equal(body.end_updated_at, 200)
    assert.equal(Object.hasOwn(body, 'nullable'), false)
    assert.equal(Object.hasOwn(body, 'client_secret'), false)
    assert.notEqual(body.sign, 'must-not-override-generated-sign')
    assert.match(body.sign, /^[A-F0-9]{32}$/)
    assert.deepEqual(result, { order_number_list_get_response: { order_sn_list: [] } })
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test('preserves unquoted large identifiers and decimal amounts through parsing and normalization', async () => {
  const orderSn = '900719925474099312345'
  const goodsId = '9223372036854775807123'
  const refundId = '184467440737095516151'
  const rawResponse = `{
    "order_detail_get_response": {
      "order_info": {
        "order_sn": ${orderSn},
        "updated_at": "2026-07-25 12:00:00",
        "goods_list": [{ "goods_id": ${goodsId}, "quantity": 2, "price": 12.34 }]
      }
    },
    "refund_detail_get_response": {
      "refund_info": {
        "id": ${refundId},
        "order_sn": ${orderSn},
        "updated_time": "2026-07-25 12:05:00",
        "status": 1,
        "refund_amount": 88.5
      }
    }
  }`

  const parsed = await callPinduoduoApi(
    'pdd.order.information.get',
    { order_sn: orderSn },
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => jsonResponse(rawResponse)
    }
  )
  const order = parsed.order_detail_get_response.order_info
  const refund = parsed.refund_detail_get_response.refund_info

  assert.equal(order.order_sn, orderSn)
  assert.equal(order.goods_list[0].goods_id, goodsId)
  assert.equal(refund.id, refundId)
  assert.equal(refund.order_sn, orderSn)
  assert.equal(order.goods_list[0].quantity, 2)
  assert.equal(order.goods_list[0].price, '12.34')
  assert.equal(refund.status, 1)
  assert.equal(refund.refund_amount, '88.5')

  const adapter = new PinduoduoCommerceAdapter()
  const orderEvent = adapter.normalizeOrder(order, { accountId: 11 })
  const refundEvent = adapter.normalizeAfterSale(refund, { accountId: 11 })

  assert.equal(orderEvent.externalEventId, `order:${orderSn}:2026-07-25 12:00:00`)
  assert.equal(orderEvent.businessKey, orderSn)
  assert.equal(orderEvent.payload.goods_list[0].goods_id, goodsId)
  assert.equal(refundEvent.externalEventId, `after_sales:${refundId}:2026-07-25 12:05:00`)
  assert.equal(refundEvent.businessKey, orderSn)
  assert.equal(refundEvent.payload.id, refundId)
})

test('keeps safe integer boundaries as numbers and decimal values as strings', async () => {
  const parsed = await callPinduoduoApi(
    'pdd.order.information.get',
    {},
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => jsonResponse(
        '{"max_safe":9007199254740991,"min_safe":-9007199254740991,"decimal":123456789012345.5,"quoted_safe":"9007199254740991"}'
      )
    }
  )

  assert.equal(parsed.max_safe, Number.MAX_SAFE_INTEGER)
  assert.equal(typeof parsed.max_safe, 'number')
  assert.equal(parsed.min_safe, Number.MIN_SAFE_INTEGER)
  assert.equal(typeof parsed.min_safe, 'number')
  assert.equal(parsed.decimal, '123456789012345.5')
  assert.equal(typeof parsed.decimal, 'string')
  assert.equal(parsed.quoted_safe, '9007199254740991')
})

test('maps a non-success HTTP response to a stable redacted error', async () => {
  const error = await rejectedError(() => callPinduoduoApi(
    'pdd.order.number.list.increment.get',
    {},
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => jsonResponse(
        `${credentials.clientSecret}:${credentials.accessToken}:response-sign-sensitive`,
        503
      )
    }
  ))

  assert.equal(error.code, 'PINDUODUO_HTTP_ERROR')
  assert.equal(error.status, 503)
  assertDoesNotLeak(error, [
    credentials.clientSecret,
    credentials.accessToken,
    'response-sign-sensitive'
  ])
})

test('maps an invalid JSON response to a stable redacted error', async () => {
  const responseSign = 'invalid-json-sign-sensitive'
  const error = await rejectedError(() => callPinduoduoApi(
    'pdd.order.number.list.increment.get',
    {},
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => jsonResponse(
        `{${credentials.clientSecret}:${credentials.accessToken}:${responseSign}`
      )
    }
  ))

  assert.equal(error.code, 'PINDUODUO_INVALID_JSON')
  assertDoesNotLeak(error, [credentials.clientSecret, credentials.accessToken, responseSign])
})

test('maps error_response to a stable error without echoing API messages or credentials', async () => {
  const responseSign = 'api-error-sign-sensitive'
  const error = await rejectedError(() => callPinduoduoApi(
    'pdd.order.number.list.increment.get',
    {},
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => jsonResponse({
        error_response: {
          error_code: 10019,
          error_msg: `${credentials.clientSecret}:${credentials.accessToken}:${responseSign}`,
          sign: responseSign
        }
      })
    }
  ))

  assert.equal(error.code, 'PINDUODUO_API_ERROR')
  assert.equal(error.apiErrorCode, '10019')
  assertDoesNotLeak(error, [credentials.clientSecret, credentials.accessToken, responseSign])
})

test('redacts a transport error even when the underlying fetch message contains secrets', async () => {
  const requestSign = 'transport-sign-sensitive'
  const error = await rejectedError(() => callPinduoduoApi(
    'pdd.order.number.list.increment.get',
    { marker: requestSign },
    credentials,
    {
      now: () => 0,
      fetchImpl: async () => {
        throw new Error(`${credentials.clientSecret}:${credentials.accessToken}:${requestSign}`)
      }
    }
  ))

  assert.equal(error.code, 'PINDUODUO_NETWORK_ERROR')
  assertDoesNotLeak(error, [credentials.clientSecret, credentials.accessToken, requestSign])
})
