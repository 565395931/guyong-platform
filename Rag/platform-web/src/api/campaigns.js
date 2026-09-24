import request from './index'

export function getTasks(params) {
  return request.get('/v1/campaigns/tasks', { params })
}

export function createTask(data) {
  return request.post('/v1/campaigns/tasks', data)
}

export function getTask(id) {
  return request.get(`/v1/campaigns/tasks/${id}`)
}

export function updateTask(id, data) {
  return request.patch(`/v1/campaigns/tasks/${id}`, data)
}

export function getCampaignBlueprints(params = {}) {
  return request.get('/v1/campaigns/blueprints', { params })
}
