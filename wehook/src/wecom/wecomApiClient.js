const TOKEN_EXPIRED_CODES = new Set([40014, 42001, 42007, 42009])

function sanitizeMessage(value) {
  return String(value || 'unknown error')
    .replace(/\b(?:corpsecret|secret|access_token|token)\s*[:=]\s*[^,;\s]+/gi, match => {
      const separator = match.includes(':') ? ':' : '='
      return `${match.split(separator)[0]}${separator}******`
    })
    .slice(0, 240)
}

function assertSuccess(data, operation) {
  const code = Number(data?.errcode || 0)
  if (code === 0) return data
  const error = new Error(`WeCom ${operation} failed (${code}): ${sanitizeMessage(data?.errmsg)}`)
  error.code = 'WECOM_API_ERROR'
  error.wecomCode = code
  throw error
}

async function defaultRequest({ method = 'GET', path, query = {}, body, timeoutMs = 15000 }) {
  const url = new URL(path, 'https://qyapi.weixin.qq.com')
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`WeCom HTTP request failed (${response.status})`)
    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

function createWecomApiClient({ request = defaultRequest, now = () => Date.now() } = {}) {
  const tokenCache = new Map()
  const refreshLocks = new Map()

  function cacheKey(config) {
    const corpId = String(config?.corpId || '').trim()
    const secret = String(config?.secret || '').trim()
    if (!corpId || !secret) throw new Error('WeCom corpId and secret are required')
    return { corpId, secret }
  }

  async function getAccessToken(config, { force = false } = {}) {
    const { corpId, secret } = cacheKey(config)
    const cached = tokenCache.get(corpId)
    if (!force && cached && cached.expiresAt > now() + 60000) return cached.accessToken
    if (refreshLocks.has(corpId)) return refreshLocks.get(corpId)
    const refresh = (async () => {
      const data = assertSuccess(await request({
        method: 'GET',
        path: '/cgi-bin/gettoken',
        query: { corpid: corpId, corpsecret: secret }
      }), 'access token request')
      const accessToken = String(data.access_token || '').trim()
      if (!accessToken) throw new Error('WeCom access token response is missing access_token')
      const expiresIn = Number(data.expires_in || 7200)
      tokenCache.set(corpId, {
        accessToken,
        expiresAt: now() + Math.max(60, expiresIn) * 1000
      })
      return accessToken
    })()
    refreshLocks.set(corpId, refresh)
    try {
      return await refresh
    } finally {
      if (refreshLocks.get(corpId) === refresh) refreshLocks.delete(corpId)
    }
  }

  async function withAccessToken(config, operation) {
    const { corpId } = cacheKey(config)
    let accessToken = await getAccessToken(config)
    try {
      return await operation(accessToken)
    } catch (error) {
      if (!TOKEN_EXPIRED_CODES.has(Number(error.wecomCode))) throw error
      tokenCache.delete(corpId)
      accessToken = await getAccessToken(config, { force: true })
      return operation(accessToken)
    }
  }

  async function syncMessages(config, { token, cursor = '', limit = 1000, openKfId } = {}) {
    const syncToken = String(token || '').trim()
    if (!syncToken) throw new Error('WeCom sync token is required')
    return withAccessToken(config, async accessToken => {
      const body = {
        cursor: String(cursor || ''),
        token: syncToken,
        limit: Math.min(1000, Math.max(1, Number(limit) || 1000)),
        voice_format: 0
      }
      if (openKfId) body.open_kfid = String(openKfId)
      const data = assertSuccess(await request({
        method: 'POST',
        path: '/cgi-bin/kf/sync_msg',
        query: { access_token: accessToken },
        body
      }), 'message sync')
      if (!Array.isArray(data.msg_list)) throw new Error('WeCom sync response is missing msg_list')
      return {
        messages: data.msg_list,
        nextCursor: String(data.next_cursor || ''),
        hasMore: Number(data.has_more || 0) === 1
      }
    })
  }

  async function sendTextMessage(config, { openKfId, externalUserId, text }) {
    const openKf = String(openKfId || '').trim()
    const target = String(externalUserId || '').trim()
    const content = String(text || '').trim()
    if (!openKf || !target || !content) throw new Error('WeCom text send fields are required')
    return withAccessToken(config, async accessToken => {
      const data = assertSuccess(await request({
        method: 'POST',
        path: '/cgi-bin/kf/send_msg',
        query: { access_token: accessToken },
        body: {
          touser: target,
          open_kfid: openKf,
          msgtype: 'text',
          text: { content }
        }
      }), 'message send')
      return { channelMessageId: data.msgid ? String(data.msgid) : null }
    })
  }

  return {
    getAccessToken,
    invalidateAccessToken(corpId) { tokenCache.delete(String(corpId || '')) },
    sendTextMessage,
    syncMessages
  }
}

module.exports = {
  TOKEN_EXPIRED_CODES,
  assertSuccess,
  createWecomApiClient,
  defaultRequest,
  sanitizeMessage
}

