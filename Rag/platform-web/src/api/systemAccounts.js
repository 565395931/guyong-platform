import request from './index'

export function listSystemAccounts(params = {}) {
  return request.get('/v1/system-accounts', { params })
}

export function createSystemAccount(data) {
  return request.post('/v1/system-accounts', data)
}

export function updateSystemAccount(id, data) {
  return request.patch(`/v1/system-accounts/${id}`, data)
}

export function resetSystemAccountPassword(id, password) {
  return request.post(`/v1/system-accounts/${id}/reset-password`, { password })
}

export function deleteSystemAccount(id) {
  return request.delete(`/v1/system-accounts/${id}`)
}
