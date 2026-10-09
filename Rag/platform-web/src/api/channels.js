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

/**
 * 检测本机运行的桌面客服客户端（目前为抖店飞鸽），用于「本地桌面客户端」接入方式。
 * 后端调用只读 UIA 探针，不点击、不发送。前提是后端与客户端同机。
 */
export function detectDesktopAccount() {
  return request.post('/v1/channel-accounts/detect-desktop', {}, { timeout: 60000 })
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
