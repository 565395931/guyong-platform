const crypto = require('crypto')
async function runtimeOptions(requestedModel) {
  const config = await require('./providerService').getProviderService().getRuntimeConfig()
  return {
    // A custom service has one selected model; legacy task-model defaults must not leak to it.
    model: config.provider === 'openai-compatible' ? config.model : requestedModel || config.model,
    apiKey: config.apiKey, maxRetries: 0,
    configuration: { baseURL: config.baseURL, fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers)
      if (!headers.has('idempotency-key')) headers.set('idempotency-key', crypto.randomUUID())
      const response = await fetch(url, { ...init, headers })
      require('./serviceMonitor').observeBalance(config, response)
      return response
    } }
  }
}
module.exports = { runtimeOptions }
