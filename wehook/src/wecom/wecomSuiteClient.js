const { assertSuccess, defaultRequest } = require('./wecomApiClient')

const MAX_IMAGE_BYTES = 12 * 1024 * 1024

async function defaultMediaRequest({ path, query = {}, timeoutMs = 15000 }) {
  const url = new URL(path, 'https://qyapi.weixin.qq.com')
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`WeCom media request failed (${response.status})`)
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (contentType === 'application/json' || contentType === 'text/plain') {
      const body = await response.json()
      assertSuccess(body, 'media download')
      throw new Error('WeCom media response did not contain an image')
    }
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > MAX_IMAGE_BYTES) throw Object.assign(new Error('企业微信图片超过允许大小'), { code: 'wecom_media_too_large' })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('企业微信图片大小无效'), { code: 'wecom_media_invalid' })
    return { buffer, contentType }
  } finally {
    clearTimeout(timeout)
  }
}

function createWecomSuiteClient({ request = defaultRequest, mediaRequest = defaultMediaRequest, now = () => Date.now() } = {}) {
  let suiteCache = null
  const corpCache = new Map()

  async function getSuiteAccessToken({ suiteId, suiteSecret, suiteTicket }, { force = false } = {}) {
    if (!suiteId || !suiteSecret || !suiteTicket) throw Object.assign(new Error('服务商套件凭据尚未完整配置'), { code: 'wecom_suite_not_ready' })
    if (!force && suiteCache && suiteCache.expiresAt > now() + 60000 && suiteCache.suiteTicket === suiteTicket) return suiteCache.accessToken
    const data = assertSuccess(await request({ method: 'POST', path: '/cgi-bin/service/get_suite_token', body: { suite_id: suiteId, suite_secret: suiteSecret, suite_ticket: suiteTicket } }), 'suite token request')
    if (!data.suite_access_token) throw new Error('WeCom suite token response is missing suite_access_token')
    suiteCache = { accessToken: String(data.suite_access_token), suiteTicket, expiresAt: now() + Math.max(60, Number(data.expires_in || 7200)) * 1000 }
    return suiteCache.accessToken
  }

  async function exchangeAuthCode(config, authCode) {
    const suiteAccessToken = await getSuiteAccessToken(config)
    const data = assertSuccess(await request({ method: 'POST', path: '/cgi-bin/service/get_permanent_code', query: { suite_access_token: suiteAccessToken }, body: { auth_code: authCode } }), 'permanent code request')
    const corpId = String(data.auth_corp_info?.corpid || '')
    const permanentCode = String(data.permanent_code || '')
    if (!corpId || !permanentCode) throw new Error('WeCom authorization response is incomplete')
    return { corpId, permanentCode, companyName: String(data.auth_corp_info?.corp_name || ''), authInfo: data.auth_info || null }
  }

  async function getPreAuthCode(config) {
    const suiteAccessToken = await getSuiteAccessToken(config)
    const data = assertSuccess(await request({ method: 'GET', path: '/cgi-bin/service/get_pre_auth_code', query: { suite_access_token: suiteAccessToken } }), 'pre auth code request')
    if (!data.pre_auth_code) throw new Error('WeCom pre-auth response is missing pre_auth_code')
    return { preAuthCode: String(data.pre_auth_code), expiresIn: Number(data.expires_in || 1200) }
  }

  async function setSessionInfo(config, preAuthCode, authType = 0) {
    if (![0, 1].includes(Number(authType))) throw new Error('WeCom authorization type must be 0 or 1')
    const suiteAccessToken = await getSuiteAccessToken(config)
    assertSuccess(await request({
      method: 'POST',
      path: '/cgi-bin/service/set_session_info',
      query: { suite_access_token: suiteAccessToken },
      body: { pre_auth_code: preAuthCode, session_info: { auth_type: Number(authType) } }
    }), 'authorization session configuration')
  }

  async function getCorpAccessToken(config, { corpId, permanentCode }, { force = false } = {}) {
    const cached = corpCache.get(corpId)
    if (!force && cached && cached.expiresAt > now() + 60000) return cached.accessToken
    const suiteAccessToken = await getSuiteAccessToken(config)
    const data = assertSuccess(await request({ method: 'POST', path: '/cgi-bin/service/get_corp_token', query: { suite_access_token: suiteAccessToken }, body: { auth_corpid: corpId, permanent_code: permanentCode } }), 'corp token request')
    if (!data.access_token) throw new Error('WeCom corp token response is missing access_token')
    corpCache.set(corpId, { accessToken: String(data.access_token), expiresAt: now() + Math.max(60, Number(data.expires_in || 7200)) * 1000 })
    return String(data.access_token)
  }

  async function syncMessages(config, installation, { token, cursor = '', openKfId } = {}) {
    const accessToken = await getCorpAccessToken(config, installation)
    const body = { cursor, token, limit: 1000, voice_format: 0 }
    if (openKfId) body.open_kfid = openKfId
    const data = assertSuccess(await request({ method: 'POST', path: '/cgi-bin/kf/sync_msg', query: { access_token: accessToken }, body }), 'message sync')
    return { messages: Array.isArray(data.msg_list) ? data.msg_list : [], nextCursor: String(data.next_cursor || ''), hasMore: Number(data.has_more || 0) === 1 }
  }

  async function sendText(config, installation, { openKfId, externalUserId, text }) {
    const accessToken = await getCorpAccessToken(config, installation)
    const data = assertSuccess(await request({ method: 'POST', path: '/cgi-bin/kf/send_msg', query: { access_token: accessToken }, body: { touser: externalUserId, open_kfid: openKfId, msgtype: 'text', text: { content: text } } }), 'message send')
    return { channelMessageId: data.msgid ? String(data.msgid) : null }
  }

  async function downloadMedia(config, installation, mediaId) {
    const id = String(mediaId || '').trim()
    if (!id) throw Object.assign(new Error('图片媒体标识缺失'), { code: 'wecom_media_missing' })
    const accessToken = await getCorpAccessToken(config, installation)
    return mediaRequest({ path: '/cgi-bin/media/get', query: { access_token: accessToken, media_id: id } })
  }

  return { downloadMedia, exchangeAuthCode, getCorpAccessToken, getPreAuthCode, getSuiteAccessToken, setSessionInfo, sendText, syncMessages }
}

module.exports = { createWecomSuiteClient, defaultMediaRequest }
