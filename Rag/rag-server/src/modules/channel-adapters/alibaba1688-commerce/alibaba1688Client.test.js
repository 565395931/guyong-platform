const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

function loadModules() {
  return {
    client: require('./alibaba1688Client'),
    signature: require('./alibaba1688Signature')
  }
}

const credentials = Object.freeze({
  appKey: '1688-app-key',
  appSecret: '1688-app-secret-sensitive',
  accessToken: '1688-access-token-sensitive'
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

test('builds the official uppercase HMAC-SHA1 signature from path and sorted parameters', () => {
  const { buildAlibaba1688Signature } = loadModules().signature
  const path = 'param2/1/com.alibaba.trade/alibaba.trade.ec.getOrderList.sellerView/abc'
  const params = {
    pageSize: 20,
    access_token: 'token',
    isHis: false,
    nullable: null,
    _aop_signature: 'must-not-participate'
  }
  const canonical = `${path}access_tokentokenisHisfalsepageSize20`
  const expected = crypto.createHmac('sha1', 'secret').update(canonical, 'utf8').digest('hex').toUpperCase()

  assert.equal(buildAlibaba1688Signature(path, params, 'secret'), expected)
})

test('posts a signed form request to the fixed order API with a ten-second timeout', async () => {
  const {
    GATEWAY_ORIGIN,
    REQUEST_TIMEOUT_MS,
    ORDER_LIST_API,
    callAlibaba1688Api
  } = loadModules().client
  const { buildAlibaba1688Signature } = loadModules().signature
  let request
  let timeout
  const expectedSignal = new AbortController().signal
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = milliseconds => {
    timeout = milliseconds
    return expectedSignal
  }

  try {
    const result = await callAlibaba1688Api(
      ORDER_LIST_API,
      {
        page: 1,
        pageSize: 20,
        needBuyerAddressAndPhone: false,
        nullable: null,
        access_token: 'must-not-override',
        _aop_signature: 'must-not-override',
        namespace: 'must-not-override'
      },
      credentials,
      {
        fetchImpl: async (url, options) => {
          request = { url, ...options }
          return textResponse({ success: true, totalRecord: 0, result: [] })
        }
      }
    )

    const expectedPath = `param2/1/com.alibaba.trade/${ORDER_LIST_API}/${credentials.appKey}`
    const body = new URLSearchParams(request.body)
    const unsigned = Object.fromEntries(body.entries())
    const signature = unsigned._aop_signature
    delete unsigned._aop_signature

    assert.equal(GATEWAY_ORIGIN, 'https://gw.open.1688.com/openapi')
    assert.equal(REQUEST_TIMEOUT_MS, 10_000)
    assert.equal(request.url, `${GATEWAY_ORIGIN}/${expectedPath}`)
    assert.equal(request.method, 'POST')
    assert.deepEqual(request.headers, {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
    })
    assert.equal(request.signal, expectedSignal)
    assert.equal(timeout, REQUEST_TIMEOUT_MS)
    assert.equal(body.get('access_token'), credentials.accessToken)
    assert.equal(body.get('page'), '1')
    assert.equal(body.get('pageSize'), '20')
    assert.equal(body.get('needBuyerAddressAndPhone'), 'false')
    assert.equal(body.has('nullable'), false)
    assert.equal(body.has('namespace'), false)
    assert.match(signature, /^[A-F0-9]{40}$/)
    assert.equal(signature, buildAlibaba1688Signature(expectedPath, unsigned, credentials.appSecret))
    assert.deepEqual(result, { success: true, totalRecord: 0, result: [] })
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test('allows only the approved order and refund APIs', async () => {
  const { REFUND_LIST_API, callAlibaba1688Api } = loadModules().client
  let refundUrl
  await callAlibaba1688Api(REFUND_LIST_API, {}, credentials, {
    fetchImpl: async url => {
      refundUrl = url
      return textResponse({ success: true, result: { opOrderRefundModels: [], totalCount: 0 } })
    }
  })
  assert.equal(refundUrl.includes(`/com.alibaba.trade/${REFUND_LIST_API}/`), true)

  const error = await rejectedError(() => callAlibaba1688Api(
    'system.unsafe.dynamicApi',
    {},
    credentials,
    { fetchImpl: async () => textResponse({}) }
  ))
  assert.equal(error.code, 'ALIBABA1688_API_NOT_ALLOWED')
})

test('parses large identifiers and decimal amounts losslessly while retaining safe integers', async () => {
  const { ORDER_LIST_API, callAlibaba1688Api } = loadModules().client
  const orderId = '900719925474099312345'
  const productId = '9223372036854775807123'
  const rawResponse = `{
    "success": true,
    "result": [{
      "baseInfo": {"id": ${orderId}, "idOfStr": "${orderId}"},
      "productItems": [{"productID": ${productId}, "quantity": 2, "price": 12.5}],
      "maxSafe": 9007199254740991,
      "decimal": 123456789012345.5,
      "quotedSafe": "9007199254740991"
    }]
  }`

  const payload = await callAlibaba1688Api(ORDER_LIST_API, {}, credentials, {
    fetchImpl: async () => textResponse(rawResponse)
  })
  const order = payload.result[0]
  assert.equal(order.baseInfo.id, orderId)
  assert.equal(order.productItems[0].productID, productId)
  assert.equal(order.maxSafe, Number.MAX_SAFE_INTEGER)
  assert.equal(typeof order.maxSafe, 'number')
  assert.equal(order.decimal, '123456789012345.5')
  assert.equal(typeof order.decimal, 'string')
  assert.equal(order.quotedSafe, '9007199254740991')
})

test('maps HTTP, invalid JSON, API and transport failures to stable redacted errors', async () => {
  const { ORDER_LIST_API, callAlibaba1688Api } = loadModules().client
  const sensitiveResponse = '1688-response-sign-sensitive'
  const cases = [
    {
      expected: 'ALIBABA1688_HTTP_ERROR',
      status: 502,
      fetchImpl: async () => textResponse(`${credentials.appSecret}:${credentials.accessToken}:${sensitiveResponse}`, 502)
    },
    {
      expected: 'ALIBABA1688_INVALID_JSON',
      fetchImpl: async () => textResponse(`{${credentials.appSecret}:${credentials.accessToken}:${sensitiveResponse}`)
    },
    {
      expected: 'ALIBABA1688_API_ERROR',
      apiErrorCode: '401',
      fetchImpl: async () => textResponse({
        success: false,
        errorCode: 401,
        errorMessage: `${credentials.appSecret}:${credentials.accessToken}:${sensitiveResponse}`
      })
    },
    {
      expected: 'ALIBABA1688_NETWORK_ERROR',
      fetchImpl: async () => {
        throw new Error(`${credentials.appSecret}:${credentials.accessToken}:${sensitiveResponse}`)
      }
    }
  ]

  for (const item of cases) {
    const error = await rejectedError(() => callAlibaba1688Api(
      ORDER_LIST_API,
      { marker: sensitiveResponse },
      credentials,
      { fetchImpl: item.fetchImpl }
    ))
    assert.equal(error.code, item.expected)
    if (item.status) assert.equal(error.status, item.status)
    if (item.apiErrorCode) assert.equal(error.apiErrorCode, item.apiErrorCode)
    assertDoesNotLeak(error, [credentials.appSecret, credentials.accessToken, sensitiveResponse])
  }
})
