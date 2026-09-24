import request from './index'

export function getAiConfig() {
  return request.get('/v1/conversations/ai-config')
}

export function updateAiConfig(key, value) {
  return request.put(`/v1/conversations/ai-config/${encodeURIComponent(key)}`, { value })
}

export const getAiProvider = () => request.get('/v1/conversations/ai-provider')
export const saveAiProviderCredential = apiKey => request.put('/v1/conversations/ai-provider', { apiKey })
export const clearAiProviderCredential = () => request.delete('/v1/conversations/ai-provider/credential')
export const testAiProvider = apiKey => request.post('/v1/conversations/ai-provider/test', apiKey ? { apiKey } : {})
export const syncAiProviderModels = () => request.post('/v1/conversations/ai-provider/models/sync')
export const getAiProviderBalance = () => request.get('/v1/conversations/ai-provider/balance')
