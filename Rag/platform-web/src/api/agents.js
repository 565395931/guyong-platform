import request from './index'

export function getAgents(params) {
  return request.get('/v1/agents', { params })
}

export function updateAgent(id, data) {
  return request.patch(`/v1/agents/${id}`, data)
}

export function updateAgentStatus(data) {
  return request.post('/v1/agents/status', data)
}

export function getSkillGroups() {
  return request.get('/v1/skill-groups')
}

export function createSkillGroup(data) {
  return request.post('/v1/skill-groups', data)
}
