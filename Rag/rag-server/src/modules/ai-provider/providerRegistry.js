const axios = require('axios')
const { normalizeOpenAiBaseUrl } = require('./openAiEndpoint')

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DASHSCOPE_MODELS_URL = 'https://dashscope.aliyuncs.com/api/v1/deployments/models'

function maskCredential(secret, source = 'none') {
  const value = String(secret || '')
  return { configured: Boolean(value), source: value ? source : 'none', lastFour: value ? value.slice(-4) : null }
}

function normalizeDashScopeModels(payload = {}) {
  const rows = payload?.output?.models || payload?.data || []
  return [...new Set(rows.map(item => item?.model_name || item?.name || item?.id).filter(Boolean))].sort()
}

function sanitizeProviderError(error) {
  if (error?.response?.status === 401 || error?.response?.status === 403) return new Error('Provider authentication failed')
  if (error?.code === 'ECONNABORTED') return new Error('Provider request timed out')
  return new Error('Provider request failed')
}

function createProviderRegistry({ request = axios.request } = {}) {
  const dashscope = {
    id: 'dashscope',
    label: '阿里云百炼 DashScope',
    baseURL: DASHSCOPE_BASE_URL,
    capabilities: { models: true, balance: false },
    async listModels({ apiKey }) {
      try {
        const response = await request({
          method: 'GET', url: DASHSCOPE_MODELS_URL,
          params: { page_no: 1, page_size: 100, version: 'v1.0', model_source: 'base' },
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 12000
        })
        return normalizeDashScopeModels(response.data)
      } catch (error) { throw sanitizeProviderError(error) }
    },
    async testConnection({ apiKey }) {
      const models = await this.listModels({ apiKey })
      return { ok: true, modelCount: models.length }
    },
    async getBalance() {
      return { supported: false, reason: 'DashScope does not expose an API-key balance endpoint' }
    }
  }
  const providers = new Map([[dashscope.id, dashscope]])
  const compatible = {
    id: 'openai-compatible', label: 'OpenAI 兼容服务', capabilities: { models: true, balance: false },
    async listModels({ apiKey, baseURL }) {
      try { const response = await request({ method: 'GET', url: `${normalizeOpenAiBaseUrl(baseURL)}/models`, headers: { Authorization: `Bearer ${apiKey}` }, timeout: 12000 }); return normalizeDashScopeModels(response.data) }
      catch (error) { throw sanitizeProviderError(error) }
    },
    async testConnection({ apiKey, baseURL, model }) {
      try {
        const response = await request({ method: 'POST', url: `${normalizeOpenAiBaseUrl(baseURL)}/chat/completions`, headers: { Authorization: `Bearer ${apiKey}` }, data: { model, messages: [{ role: 'user', content: '只回复：连接成功' }], max_tokens: 128, stream: false }, timeout: 30000 })
        if (response.data?.error || !response.data?.choices?.[0]?.message) throw new Error('Unsupported response format')
        return { ok: true, protocol: 'openai-chat-completions', model }
      } catch (error) { throw sanitizeProviderError(error) }
    },
    async getBalance({ apiKey, baseURL }) {
      try {
        const response = await request({ method: 'GET', url: `${normalizeOpenAiBaseUrl(baseURL)}/billing/account`, headers: { Authorization: `Bearer ${apiKey}` }, timeout: 12000 })
        const data = response.data?.data
        if (data?.currency === 'CNY' && data.unit === 1e9 && Number.isSafeInteger(data.balance)) return { supported: true, managed: true, currency: '¥', amount: data.balance / data.unit, billing: data }
      } catch (error) {
        if ([401, 403].includes(error.response?.status)) return { supported: false, managed: false, reason: '凭证未通过服务商验证' }
      }
      return { supported: false, managed: true, reason: '余额暂时无法同步' }
    }
  }
  providers.set(compatible.id, compatible)
  return {
    get(id) {
      const provider = providers.get(id)
      if (!provider) throw new Error('Unsupported AI provider')
      return provider
    },
    list() {
      return [...providers.values()].map(({ id, label, baseURL, capabilities }) => ({ id, label, baseURL, capabilities }))
    }
  }
}

module.exports = { createProviderRegistry, maskCredential, normalizeDashScopeModels, DASHSCOPE_BASE_URL }
