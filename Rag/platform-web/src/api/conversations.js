import request from './index'

export function getConversations(params, config = {}) {
  return request.get('/v1/conversations', { params, ...config })
}

/**
 * 全局搜索会话（跨所有池/所有坐席/含消息内容）
 * @param {string} q - 搜索关键词
 * @param {object} params - { limit, offset, start_date, end_date }
 * @returns {Promise} { list, total, limit, offset } — list 含 match_type/matched_text
 */
export function searchConversations(q, params = {}, config = {}) {
  return request.get('/v1/conversations/search', { params: { q, ...params }, ...config })
}

export function getConversation(id) {
  return request.get(`/v1/conversations/${id}`)
}

export function updateConversation(id, data) {
  return request.patch(`/v1/conversations/${id}`, data)
}

export function getNationalityDictionary() {
  return request.get('/v1/conversations/nationalities')
}

export function inferConversationNationality(id) {
  return request.post(`/v1/conversations/${id}/infer-nationality`)
}

/**
 * 标记会话已读（清零未读数）
 * @param {string} id - 会话 ID
 */
export function markConversationRead(id) {
  return request.post(`/v1/conversations/${id}/read`)
}

export function assignConversation(id, data) {
  return request.post(`/v1/conversations/${id}/assign`, data)
}

export function syncHistory(id, data = {}) {
  return request.post(`/v1/conversations/${id}/sync-history`, data)
}

// ========== 会话池驱动 API ==========

/**
 * 获取各池数量统计
 * @returns {Promise} { ai_self, pending_human, public, long_term, private, all }
 */
export function getPoolStats() {
  return request.get('/v1/conversations/pool-stats')
}

/**
 * 抢单（坐席认领会话）
 * @param {string} id - 会话 ID
 */
export function claimConversation(id, data = {}) {
  return request.post(`/v1/conversations/${id}/claim`, data)
}

/**
 * 获取可分配坐席（admin/supervisor）
 */
export function getAssignableSeats() {
  return request.get('/v1/conversations/assignable-seats')
}

/**
 * 释放会话回公共池
 * @param {string} id - 会话 ID
 */
export function releaseConversation(id) {
  return request.post(`/v1/conversations/${id}/release`)
}

/**
 * 标记长期跟进
 * @param {string} id - 会话 ID
 * @param {number|null} bindSeatId - 绑定坐席 ID（管理员功能）
 */
export function markLongTerm(id, bindSeatId = null) {
  return request.post(`/v1/conversations/${id}/mark-long-term`, { bind_seat_id: bindSeatId })
}

/**
 * 归档会话
 * @param {string} id - 会话 ID
 */
export function archiveConversation(id) {
  return request.post(`/v1/conversations/${id}/archive`)
}

/**
 * 复活归档会话（从归档 → 待人工池）
 * @param {string} id - 会话 ID
 */
export function reviveConversation(id) {
  return request.post(`/v1/conversations/${id}/revive`)
}

/**
 * 手动转入 AI 自助池
 * @param {string} id - 会话 ID
 */
export function transferToAi(id) {
  return request.post(`/v1/conversations/${id}/transfer-to-ai`)
}

/**
 * 转交会话（supervisor/admin）
 * @param {string} id - 会话 ID
 * @param {number} toSeatId - 目标坐席 ID
 */
export function transferConversation(id, toSeatId) {
  return request.post(`/v1/conversations/${id}/transfer`, { to_seat_id: toSeatId })
}

/**
 * 更新坐席在线状态
 * @param {string} status - online/offline/away/busy
 */
export function updateSeatStatus(status) {
  return request.post('/v1/conversations/seat-status', { status })
}

/**
 * 获取坐席负载信息
 * @returns {Promise} { canClaim, current, max }
 */
export function getSeatLoad() {
  return request.get('/v1/conversations/seat-load')
}

/**
 * 查询池操作日志（supervisor/admin）
 */
export function getPoolLogs(params = {}) {
  return request.get('/v1/conversations/pool-logs', { params })
}

/**
 * 获取/刷新联系人头像
 * @param {string} id - 会话 ID
 * @param {boolean} force - 是否强制刷新（忽略已有头像）
 */
export function fetchAvatar(id, force = false) {
  return request.post(`/v1/conversations/${id}/fetch-avatar`, { force })
}

/**
 * 批量回填头像
 * @param {number} batchSize - 每批数量
 */
export function batchFetchAvatars(batchSize = 20) {
  return request.post('/v1/conversations/batch-fetch-avatars', { batchSize })
}
