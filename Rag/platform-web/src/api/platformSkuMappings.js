import request from './index'

export function getPlatformSkuMappings(filters = {}) {
  return request.get('/v1/platform-sku-mappings', { params: filters })
}

export function savePlatformSkuMapping(data) {
  return request.post('/v1/platform-sku-mappings', data)
}

export function setPlatformSkuMappingStatus(id, status) {
  return request.patch(`/v1/platform-sku-mappings/${encodeURIComponent(id)}/status`, { status })
}
