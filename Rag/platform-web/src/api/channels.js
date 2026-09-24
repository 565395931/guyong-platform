import request from './index'
import { normalizeChannelAccountOptions } from '@/modules/platformMessages/platformFilters'

export function getChannelDefinitions(params = { status: 'active' }) {
  return request.get('/v1/channel-accounts/channels', { params })
}

export function getChannelAccounts(params) {
  return request.get('/v1/channel-accounts', { params })
}

export async function getChannelAccountOptions(params = {}) {
  const response = await getChannelAccounts(params)
  return {
    ...response,
    data: normalizeChannelAccountOptions(response.data)
  }
}

export function createChannelAccount(data) {
  return request.post('/v1/channel-accounts', data)
}

export function deleteChannelAccount(id) {
  return request.delete(`/v1/channel-accounts/${id}`)
}

export function getChannelEvents(params) {
  return request.get('/v1/channel-events', { params })
}

export function getChannelEvent(id) {
  return request.get(`/v1/channel-events/${id}`)
}

export function getChannelEventAccounts(params) {
  return request.get('/v1/channel-events/accounts', { params })
}

export function getChannelProjectionSummary(params) {
  return request.get('/v1/channel-events/projection-summary', { params })
}

// WAHA 健康状态
export function getWahaHealthStatus() {
  return request.get('/v1/waha/health-status')
}

// 多渠道连接状态摘要
export function getChannelsStatus() {
  return request.get('/v1/channels/status')
}
