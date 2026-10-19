const API = 'https://api.weixin.qq.com'

function fail(message, code = 'shop_api_error') { throw Object.assign(new Error(message), { code }) }

function validateMediaUrl(value) {
  if (String(value || '').length > 8192) fail('图片地址过长', 'shop_media_invalid')
  let url
  try { url = new URL(value) } catch { fail('图片地址无效', 'shop_media_invalid') }
  if (url.protocol !== 'https:' || url.hostname !== 'channels.weixin.qq.com' || url.port || url.username || url.password || url.pathname !== '/shop/commkf/downloadmedia') {
    fail('图片地址不属于微信小店素材服务', 'shop_media_invalid')
  }
  return url.href
}

function createWechatShopClient({ fetchImpl = fetch } = {}) {
  async function request(path, body, accessToken) {
    try {
      const url = new URL(path, API)
      if (accessToken) url.searchParams.set('access_token', accessToken)
      const response = await fetchImpl(url.href, {
        method: 'POST', headers: body instanceof FormData ? {} : { 'content-type': 'application/json' },
        body: body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error'
      })
      if (!response.ok) fail(`微信小店服务返回 HTTP ${response.status}，请重试`, 'shop_transport_error')
      const data = await response.json()
      if (Number(data.errcode || 0)) {
        const code = Number(data.errcode)
        const hints = { 40164: '请把服务器出口 IP 加入小店接口白名单', 40001: '请核对小店 AppID 和 AppSecret', 40125: '小店 AppSecret 无效', 40014: '小店访问凭据已失效，请重新测试连接', 42001: '小店访问凭据已过期，请重新测试连接', 48001: '该小店没有此接口权限', 10190003: '请确认小店已切换为自研客服模式', 10190008: '已达到本轮最多 5 条回复限制', 10190009: '客户最后发消息已超过 48 小时', 10190010: '消息被微信小店风控拒绝，未发送成功；请调整内容后重试（10190010）', 10190013: '客户已结束会话' }
        throw Object.assign(new Error(hints[code] || `微信小店接口失败（错误码 ${code}）`), { code: 'shop_api_error', shopCode: code })
      }
      return data
    } catch (error) {
      if (['shop_api_error', 'shop_transport_error'].includes(error.code)) throw error
      fail('微信小店请求未完成，请重试；发送重试会使用同一任务编号', 'shop_transport_error')
    }
  }
  return {
    async getToken({ appId, appSecret }) {
      const data = await request('/cgi-bin/stable_token', { grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: false })
      if (!data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 60) fail('微信小店没有返回有效访问凭据')
      return { accessToken: data.access_token, expiresIn: data.expires_in }
    },
    async sendText({ accessToken, openId, text, requestId }) {
      const data = await request('/channels/ec/commkf/sendmsg', { request_id: requestId, open_id: openId, msg_type: 'text', text: { content: text } }, accessToken)
      if (!data.msg_id) fail('微信小店没有返回消息编号')
      return { channelMessageId: String(data.msg_id) }
    },
    async uploadImage({ accessToken, openId, buffer, mimeType }) {
      const form = new FormData()
      form.set('open_id', openId); form.set('msg_type', 'image')
      form.set('file', new Blob([buffer], { type: mimeType }), mimeType === 'image/png' ? 'image.png' : 'image.jpg')
      const data = await request('/channels/ec/commkf/cosupload', form, accessToken)
      if (!data.cos_url) fail('微信小店没有返回图片素材地址')
      return { cosUrl: validateMediaUrl(data.cos_url) }
    },
    async sendImage({ accessToken, openId, cosUrl, requestId }) {
      const data = await request('/channels/ec/commkf/sendmsg', { request_id: requestId, open_id: openId, msg_type: 'image', image: { cos_url: cosUrl } }, accessToken)
      if (!data.msg_id) fail('微信小店没有返回消息编号', 'shop_transport_error')
      return { channelMessageId: String(data.msg_id) }
    },
    async listOrders({ accessToken, openId, startTime, endTime, nextKey = '' }) {
      return request('/channels/ec/order/list/get', { openid: openId, create_time_range: { start_time: startTime, end_time: endTime }, page_size: 20, next_key: nextKey }, accessToken)
    },
    async getOrder({ accessToken, orderId }) {
      return request('/channels/ec/order/get', { order_id: orderId }, accessToken)
    },
    async downloadMedia({ url }) {
      const safeUrl = validateMediaUrl(url)
      try {
        const response = await fetchImpl(safeUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' })
        if (!response.ok) fail('小店图片无法读取或已过期', 'shop_media_missing')
        const limit = 8 * 1024 * 1024
        if (Number(response.headers.get('content-length')) > limit) fail('图片超过 8MB 预览上限', 'shop_media_too_large')
        const chunks = []; let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > limit) { fail('图片超过 8MB 预览上限', 'shop_media_too_large') }
          chunks.push(Buffer.from(chunk))
        }
        return { buffer: Buffer.concat(chunks) }
      } catch (error) {
        if (String(error.code || '').startsWith('shop_media_')) throw error
        fail('小店图片暂时无法读取，请稍后重试', 'shop_media_missing')
      }
    }
  }
}

module.exports = { createWechatShopClient, validateMediaUrl }
