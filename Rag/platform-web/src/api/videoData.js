import request from './index'

export function getVideoDataRecords(params = {}) {
  return request.get('/v1/video-data', { params })
}

export function getVideoDataSummary(params = {}) {
  return request.get('/v1/video-data/summary', { params })
}

export function createVideoDataRecord(data) {
  return request.post('/v1/video-data', data)
}

export function updateVideoDataRecord(id, data) {
  return request.put(`/v1/video-data/${id}`, data)
}

export function deleteVideoDataRecord(id) {
  return request.delete(`/v1/video-data/${id}`)
}

export function exportVideoData(params = {}) {
  return request.get('/v1/video-data/export', {
    params,
    responseType: 'blob'
  })
}

