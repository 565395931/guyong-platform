/**
 * WebSocket 模块入口
 *
 * 使用方式（在 app.js 中）：
 *   const { initializeWebSocket } = require('./modules/websocket')
 *   const httpServer = http.createServer(app)
 *   initializeWebSocket(httpServer, eventEmitter)
 */

const { initializeSocket, getIO } = require('./socketHandler')
const { initializePushService } = require('./pushService')

/**
 * 初始化 WebSocket 服务
 * 1. 创建 Socket.IO 服务并绑定到 HTTP 服务器
 * 2. 注册连接认证中间件和事件处理
 * 3. 初始化推送服务，绑定 EventEmitter 监听
 *
 * @param {http.Server} httpServer - HTTP 服务器实例
 * @param {EventEmitter} eventEmitter - 全局事件发射器
 * @returns {Object} { io, emitNewMessage, emitRagSuggestion }
 */
function initializeWebSocket(httpServer, eventEmitter) {
  // 1. 初始化 Socket.IO（传入 eventEmitter 用于断开连接时自动释放）
  const io = initializeSocket(httpServer, eventEmitter)

  // 2. 初始化推送服务（监听 EventEmitter 事件）
  initializePushService(eventEmitter)

  return {
    io,
    getIO,
    // 便捷方法：供业务模块发射事件
    emitNewMessage: (message) => eventEmitter.emit('newMessage', message),
    emitMessageUpdate: (data) => eventEmitter.emit('messageUpdate', data),
    emitConversationUpdate: (data) => eventEmitter.emit('conversationUpdate', data),
    emitRagSuggestion: (data) => eventEmitter.emit('ragSuggestionReady', data)
  }
}

module.exports = {
  initializeWebSocket,
  getIO
}
