import request from './index'

export function getCustomers(params = {}) {
  return request.get('/v1/customers', { params })
}

export function createCustomer(data) {
  return request.post('/v1/customers', data)
}

export function updateCustomer(id, data) {
  return request.put(`/v1/customers/${id}`, data)
}

export function deleteCustomer(id) {
  return request.delete(`/v1/customers/${id}`)
}

export function getCustomerProfile(id) {
  return request.get(`/v1/customers/${id}/profile`)
}

/**
 * Load the customer workspace context for a conversation. The server resolves
 * the customer through the conversation identity and applies the current
 * user's visibility rules.
 */
export function getConversationCustomerContext(conversationId, config = {}) {
  return request.get(`/v1/conversations/${encodeURIComponent(conversationId)}/customer-context`, config)
}

export function getDailyCustomerReport(params = {}) {
  return request.get('/v1/customers/daily-report', { params })
}

export function regenerateDailyCustomerReport(data = {}) {
  return request.post('/v1/customers/daily-report/regenerate', data)
}

export function markCustomerWon(id) {
  return request.post(`/v1/customers/${id}/won`)
}

export function completeCustomerFollowup(customerId, followupId) {
  return request.post(`/v1/customers/${customerId}/followups/${followupId}/complete`)
}

export function skipCustomerFollowup(customerId, followupId) {
  return request.post(`/v1/customers/${customerId}/followups/${followupId}/skip`)
}

export function updateCustomerFollowup(customerId, followupId, data) {
  return request.patch(`/v1/customers/${customerId}/followups/${followupId}`, data)
}
