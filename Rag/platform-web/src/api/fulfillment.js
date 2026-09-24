import request from './index'

export function reserveOrderFulfillment(orderId, data) {
  return request.post(`/v1/fulfillment/orders/${encodeURIComponent(orderId)}/reserve`, data)
}

export function shipOrderFulfillment(orderId, data) {
  return request.post(`/v1/fulfillment/orders/${encodeURIComponent(orderId)}/ship`, data)
}
