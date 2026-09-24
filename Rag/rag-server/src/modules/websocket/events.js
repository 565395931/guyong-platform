/**
 * WebSocket 推送事件常量
 * 用于 EventEmitter 内部事件和 Socket.IO 客户端事件
 */

// ========== EventEmitter 内部事件（业务模块 → pushService）==========
const INTERNAL_EVENTS = {
  NEW_MESSAGE: 'newMessage',                    // 新消息到达
  MESSAGE_UPDATE: 'messageUpdate',              // 消息状态变更（送达/已读）
  CONVERSATION_UPDATE: 'conversationUpdate',    // 会话分配/转接/结束/池变更
  RAG_SUGGESTION_READY: 'ragSuggestionReady',   // RAG 推荐结果生成完毕
  AI_REPLY_STATUS: 'aiReplyStatus',             // AI 自动回复任务状态（仅客服工作台内部可见）
  POOL_CHANGE: 'poolChange',                    // 会话池变更
  CLAIM: 'claim',                               // 抢单
  RELEASE: 'release',                           // 释放
  SEAT_STATUS_CHANGE: 'seatStatusChange'        // 坐席状态变更
}

// ========== Socket.IO 推送给前端的事件名 ==========
const SOCKET_EVENTS = {
  NEW_MESSAGE: 'new_message',
  MESSAGE_UPDATE: 'message_update',
  CONVERSATION_UPDATE: 'conversation_update',
  RAG_SUGGESTION_READY: 'rag_suggestion_ready',
  AI_REPLY_STATUS: 'ai_reply_status',
  POOL_CHANGE: 'pool_change',
  CLAIM: 'claim',
  RELEASE: 'release',
  SEAT_STATUS_CHANGE: 'seat_status_change',
  POOL_STATS_UPDATE: 'pool_stats_update'
}

// ========== 房间命名规则 ==========
const ROOMS = {
  // 个人房间：user:<userId>
  userRoom: (userId) => `user:${userId}`,
  // 公共池房间：未分配会话的消息推送到这里
  PUBLIC_POOL: 'public_pool',
  // AI 自助池房间
  AI_SELF_POOL: 'pool:ai_self',
  // 待人工池房间
  PENDING_HUMAN_POOL: 'pool:pending_human',
  // 技能组房间：skill_group:<groupId>（二期用）
  skillGroupRoom: (groupId) => `skill_group:${groupId}`,
  // 会话房间
  conversationRoom: (conversationId) => `conversation:${conversationId}`,
  // 按池类型获取房间名
  poolRoom: (poolType) => {
    switch (poolType) {
      case 'ai_self': return 'pool:ai_self'
      case 'pending_human': return 'pool:pending_human'
      case 'public': return 'public_pool'
      default: return 'public_pool'
    }
  }
}

module.exports = {
  INTERNAL_EVENTS,
  SOCKET_EVENTS,
  ROOMS
}
