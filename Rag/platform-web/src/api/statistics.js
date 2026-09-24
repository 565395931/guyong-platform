import request from './index'

export function getOverview(params) {
  return request.get('/v1/statistics/overview', { params })
}

export function getAgentPerformance(params) {
  return request.get('/v1/statistics/agent-performance', { params })
}

export function getAfterSalesStats(params) {
  return request.get('/v1/statistics/after-sales', { params })
}

export function exportReport(params) {
  return request.post('/v1/statistics/export', params, { responseType: 'blob' })
}

