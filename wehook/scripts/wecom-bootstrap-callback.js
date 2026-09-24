const http = require('http')

const { createCallbackCrypto } = require('../src/wecom/callbackCrypto')

function textResponse(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(body)
}

function createBootstrapCallbackServer({ token, encodingAesKey, receiveId, callbackKey }) {
  const routeKey = String(callbackKey || '').trim()
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(routeKey)) {
    throw new Error('callbackKey must contain 8-128 URL-safe characters')
  }
  const callbackCrypto = createCallbackCrypto({ token, encodingAesKey, receiveId })
  const routePath = `/wecom/bootstrap/${routeKey}`

  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://bootstrap.local')
    if (req.method !== 'GET' || requestUrl.pathname !== routePath) {
      return textResponse(res, 404, 'not found')
    }

    try {
      const echo = callbackCrypto.decrypt({
        signature: requestUrl.searchParams.get('msg_signature'),
        timestamp: requestUrl.searchParams.get('timestamp'),
        nonce: requestUrl.searchParams.get('nonce'),
        encrypted: requestUrl.searchParams.get('echostr')
      })
      return textResponse(res, 200, echo)
    } catch {
      return textResponse(res, 400, 'invalid callback')
    }
  })
}

if (require.main === module) {
  const host = process.env.WECOM_BOOTSTRAP_HOST || '127.0.0.1'
  const port = Number.parseInt(process.env.WECOM_BOOTSTRAP_PORT || '8790', 10)
  const callbackKey = process.env.WECOM_BOOTSTRAP_CALLBACK_KEY
  const server = createBootstrapCallbackServer({
    token: process.env.WECOM_BOOTSTRAP_TOKEN,
    encodingAesKey: process.env.WECOM_BOOTSTRAP_AES_KEY,
    receiveId: process.env.WECOM_BOOTSTRAP_RECEIVE_ID,
    callbackKey
  })
  server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({
      event: 'wecom.bootstrap_callback_ready',
      host,
      port,
      path: `/wecom/bootstrap/${callbackKey}`
    })}\n`)
  })
}

module.exports = { createBootstrapCallbackServer }
