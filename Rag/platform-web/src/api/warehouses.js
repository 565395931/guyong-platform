import request from './index'

export function getWarehouses() {
  return request.get('/v1/warehouses')
}

export function createWarehouse(data) {
  return request.post('/v1/warehouses', data)
}

export function getWarehouseInventory(code) {
  return request.get(`/v1/warehouses/${encodeURIComponent(code)}/inventory`)
}

export function adjustWarehouseInventory(code, data) {
  return request.post(`/v1/warehouses/${encodeURIComponent(code)}/inventory/adjust`, data)
}

export function reserveWarehouseStock(code, data) {
  return request.post(`/v1/warehouses/${encodeURIComponent(code)}/reservations`, data)
}

export function getWarehouseReservations(code, status = '') {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return request.get(`/v1/warehouses/${encodeURIComponent(code)}/reservations${query}`)
}

export function getWarehouseLedger(code, filters = {}) {
  const query = new URLSearchParams()
  for (const key of ['skuCode', 'operationType', 'page', 'pageSize']) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') query.set(key, String(filters[key]))
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request.get(`/v1/warehouses/${encodeURIComponent(code)}/ledger${suffix}`)
}

export function releaseWarehouseReservation(key) {
  return request.post(`/v1/warehouses/reservations/${encodeURIComponent(key)}/release`)
}

export function fulfillWarehouseReservation(key) {
  return request.post(`/v1/warehouses/reservations/${encodeURIComponent(key)}/fulfill`)
}
