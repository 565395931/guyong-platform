const crypto = require('crypto')

function douyinError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function bodyText(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8')
  if (typeof rawBody === 'string') return rawBody
  throw douyinError('douyin_raw_body_required', '抖店回调验签需要原始请求体')
}

function createEventSignature({ appId, appSecret, rawBody }) {
  const id = String(appId || '')
  const secret = String(appSecret || '')
  if (!id || !secret) throw douyinError('douyin_credentials_required', '抖店 App Key 和 App Secret 不能为空')
  const signParam = `${id}${bodyText(rawBody)}${secret}`
  return crypto.createHmac('sha256', secret).update(signParam, 'utf8').digest('hex')
}

function safeHexEqual(actual, expected) {
  const left = Buffer.from(String(actual || '').toLowerCase(), 'utf8')
  const right = Buffer.from(String(expected || '').toLowerCase(), 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function verifyEventSignature({ appId, expectedAppId, appSecret, rawBody, signature }) {
  if (String(appId || '') !== String(expectedAppId || '')) {
    throw douyinError('douyin_app_id_mismatch', '抖店回调 App ID 与账号配置不一致')
  }
  const expected = createEventSignature({ appId: expectedAppId, appSecret, rawBody })
  if (!safeHexEqual(signature, expected)) {
    throw douyinError('douyin_signature_invalid', '抖店回调签名校验失败')
  }
  return true
}

module.exports = { createEventSignature, verifyEventSignature }

