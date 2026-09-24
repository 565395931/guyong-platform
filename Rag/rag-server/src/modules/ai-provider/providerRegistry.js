const axios = require('axios')

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
