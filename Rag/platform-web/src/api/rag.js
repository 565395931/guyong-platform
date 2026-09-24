import request from './index'

export function getSuggestions(msgId) {
  return request.get(`/v1/messages/${msgId}/suggestions`)
}

export function submitFeedback(suggestionId, data) {
  return request.post(`/v1/rag-suggestions/${suggestionId}/feedback`, data)
}
