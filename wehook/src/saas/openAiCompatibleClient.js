const PRIVATE_HOSTS = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i

function modelError(message, code = 'model_request_failed') {
  return Object.assign(new Error(message), { code })
}

function normalizeBaseUrl(value, { allowInsecure = false } = {}) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw modelError('模型 API 地址格式不正确', 'invalid_model_base_url') }
  if (url.username || url.password || url.search || url.hash) throw modelError('模型 API 地址不能包含账号、查询参数或锚点', 'invalid_model_base_url')
  if (!allowInsecure && url.protocol !== 'https:') throw modelError('模型 API 地址必须使用 HTTPS', 'invalid_model_base_url')
  if (PRIVATE_HOSTS.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) throw modelError('模型 API 地址不能指向本机或内网地址', 'invalid_model_base_url')
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  url.pathname = pathname === '' ? '/v1' : pathname
  return url.toString().replace(/\/$/, '')
}

async function defaultTransport({ url, apiKey, body, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw modelError(`模型服务返回 HTTP ${response.status}`, 'model_http_error')
    if (payload.error) throw modelError('模型服务拒绝了请求，请检查供应商配置', 'model_api_error')
    return payload
  } catch (error) {
    if (error.name === 'AbortError') throw modelError('模型服务响应超时', 'model_timeout')
    throw error
  } finally { clearTimeout(timeout) }
}

function createOpenAiCompatibleClient({ transport = defaultTransport, allowInsecure = false } = {}) {
  async function complete(config, { messages, maxTokens, temperature } = {}) {
    const baseUrl = normalizeBaseUrl(config.baseUrl, { allowInsecure })
    const apiKey = String(config.apiKey || '').trim()
    const model = String(config.model || '').trim()
    if (!apiKey) throw modelError('请填写模型 API Key', 'model_api_key_required')
    if (!model) throw modelError('请填写模型名称', 'model_name_required')
    const body = {
      model,
      messages,
      stream: false,
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : Number(config.temperature ?? 0.8),
      max_tokens: Math.min(8192, Math.max(1, Number(maxTokens || config.maxTokens || 2000)))
    }
    const apiHost = new URL(baseUrl).hostname.toLowerCase()
    if (apiHost === 'api.deepseek.com' && model.toLowerCase().startsWith('deepseek-')) {
      body.thinking = { type: 'disabled' }
    }
    const payload = await transport({
      url: `${baseUrl}/chat/completions`, apiKey, timeoutMs: Number(config.timeoutMs || 30000),
      body
    })
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(modelError('模型响应中没有可用文本', 'model_empty_response'), { usage: payload.usage || null })
    return { content: content.trim(), usage: payload.usage || null, model: payload.model || model }
  }
  return { complete, normalizeBaseUrl: value => normalizeBaseUrl(value, { allowInsecure }) }
}

module.exports = { createOpenAiCompatibleClient, defaultTransport, normalizeBaseUrl }
