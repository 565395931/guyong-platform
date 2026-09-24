import request from './index'

export function getVideoTemplates(params = {}) {
  return request.get('/v1/video/templates', { params })
}

export function generateVideo(data) {
  return request.post('/v1/video/generate', data)
}
