import request from './index'

export function getAiConfig() {
  return request.get('/v1/conversations/ai-config')
}

export function updateAiConfig(key, value) {
  return request.put(`/v1/conversations/ai-config/${encodeURIComponent(key)}`, { value })
}

export const getAiProvider = () => request.get('/v1/conversations/ai-provider')
export const saveAiProviderCredential = apiKey => request.put('/v1/conversations/ai-provider', { apiKey })
export const saveAiProviderConnection = payload => request.put('/v1/conversations/ai-provider', payload)
export const clearAiProviderCredential = () => request.delete('/v1/conversations/ai-provider/credential')
export const testAiProvider = payload => request.post('/v1/conversations/ai-provider/test', typeof payload === 'string' ? { apiKey: payload } : payload || {})
export const syncAiProviderModels = payload => request.post('/v1/conversations/ai-provider/models/sync', payload || {})
export const getAiProviderBalance = () => request.get('/v1/conversations/ai-provider/balance')

// 百炼（阿里云）应用凭据：密文存后端，接口只回掩码
export const getBailianCredential = () => request.get('/v1/conversations/bailian-credential')
export const saveBailianCredential = payload => request.put('/v1/conversations/bailian-credential', payload)
export const clearBailianCredential = () => request.delete('/v1/conversations/bailian-credential')

export const resetAiProviderConnection = () => request.delete('/v1/conversations/ai-provider/connection')
export const testAiPlayground = payload => request.post('/v1/conversations/ai-provider/playground', payload, { timeout: 70000 })
export const getBailianRetrieval = () => request.get('/v1/conversations/bailian-retrieval')
export const saveBailianRetrieval = payload => request.put('/v1/conversations/bailian-retrieval', payload)
export const testBailianRetrieval = query => request.post('/v1/conversations/bailian-retrieval/test', { query }, { timeout: 30000 })

export const setAiProviderEnabled = enabled => request.put('/v1/conversations/ai-provider/enabled', {enabled})
export const setBailianRetrievalEnabled = enabled => request.put('/v1/conversations/bailian-retrieval/enabled', {enabled})

export const saveDefaultPromptTemplate = template => request.put('/v1/conversations/ai-provider/prompt-template', {template})

export const saveChannelPrompts = prompts => request.put('/v1/conversations/ai-provider/channel-prompts', {prompts})
