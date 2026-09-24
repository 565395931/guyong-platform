import request from './index'

export function getOrders(params = {}) {
  return request.get('/v1/orders', { params })
}

export function getOrder(id) {
  return request.get(`/v1/orders/${id}`)
}

export function createOrder(data) {
  return request.post('/v1/orders', data)
}

export function updateOrder(id, data) {
  return request.put(`/v1/orders/${id}`, data)
}

export function deleteOrder(id) {
  return request.delete(`/v1/orders/${id}`)
}

export function createOrderFromConversation(conversationId, data = {}) {
  return request.post(`/v1/orders/from-conversation/${conversationId}`, data)
}

export function appendOrderEvent(id, data) {
  return request.post(`/v1/orders/${id}/events`, data)
}

export function uploadOrderAttachments(id, formData) {
  return request.post(`/v1/orders/${id}/attachments`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

export function deleteOrderAttachment(orderId, attachmentId) {
  return request.delete(`/v1/orders/${orderId}/attachments/${attachmentId}`)
}

export function getOrderOptions(params = {}) {
  return request.get('/v1/orders/options', { params })
}

export function createOrderOption(data) {
  return request.post('/v1/orders/options', data)
}

export function deleteOrderOption(id) {
  return request.delete(`/v1/orders/options/${id}`)
}

export function getInvoices(params = {}) {
  return request.get('/v1/tools/invoices', { params })
}

export function generateInvoice(data) {
  return request.post('/v1/tools/invoices/generate', data)
}
