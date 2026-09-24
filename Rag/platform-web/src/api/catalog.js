import request from './index'

export const getCatalogVersions = () => request.get('/v1/catalog/versions')
export const createCatalogDraft = () => request.post('/v1/catalog/versions/draft')
export const publishCatalogVersion = id => request.post(`/v1/catalog/versions/${id}/publish`)

export const getProducts = versionId => request.get(`/v1/catalog/versions/${versionId}/products`)
export const saveProduct = (versionId, data) => data.id || data.product_code
  ? request.put(`/v1/catalog/versions/${versionId}/products/${encodeURIComponent(data.productCode || data.product_code)}`, data)
  : request.post(`/v1/catalog/versions/${versionId}/products`, data)

export const getSkus = versionId => request.get(`/v1/catalog/versions/${versionId}/skus`)
export const saveSku = (versionId, data) => data.id || data.sku_code
  ? request.put(`/v1/catalog/versions/${versionId}/skus/${encodeURIComponent(data.skuCode || data.sku_code)}`, data)
  : request.post(`/v1/catalog/versions/${versionId}/skus`, data)

export const getPriceRules = versionId => request.get(`/v1/catalog/versions/${versionId}/prices`)
export const savePriceRule = (versionId, data) => data.id
  ? request.put(`/v1/catalog/versions/${versionId}/prices/${data.id}`, data)
  : request.post(`/v1/catalog/versions/${versionId}/prices`, data)

export const getFreightRules = versionId => request.get(`/v1/catalog/versions/${versionId}/freight`)
export const saveFreightRule = (versionId, data) => data.id
  ? request.put(`/v1/catalog/versions/${versionId}/freight/${data.id}`, data)
  : request.post(`/v1/catalog/versions/${versionId}/freight`, data)

export function previewCatalogImport(file) {
  const body = new FormData()
  body.append('file', file)
  return request.post('/v1/catalog/import/preview', body, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

export const commitCatalogImport = jobId => request.post(`/v1/catalog/import/${jobId}/commit`)
export const resolveQuote = data => request.post('/v1/catalog/quote/resolve', data)
