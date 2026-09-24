/**
 * Socket.IO 连接认证、事件注册、房间管理
 */
const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const { ROOMS } = require('./events')
const poolService = require('../conversation-pool/pool.service')
const { SEAT_STATUS } = require('../conversation-pool/constants')

// JWT 密钥：生产环境必须通过环境变量配置，禁止使用硬编码默认值
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[WebSocket] 生产环境必须配置 JWT_SECRET 环境变量')
  }
  console.warn('[WebSocket] 警告：未配置 JWT_SECRET 环境变量，使用开发默认密钥（生产环境不可用）')
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'

// 单例 Socket.IO 实例
let io = null

const seatSockets = new Map()
const seatOfflineTimers = new Map()
const seatOfflineGraceMs = Number.parseInt(process.env.SEAT_OFFLINE_GRACE_MS || '30000', 10)

function isSeatRole(role) {
  return role === 'agent' || role === 'supervisor' || role === 'admin'
}

function shouldAutoReleaseOnOffline(role) {
  return role === 'agent' || role === 'supervisor'
}

function addSeatSocket(userId, socketId) {
  const key = String(userId)
  const sockets = seatSockets.get(key) || new Set()
  sockets.add(socketId)
  seatSockets.set(key, sockets)

  const timer = seatOfflineTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    seatOfflineTimers.delete(key)
  }
}

function removeSeatSocket(userId, socketId) {
  const key = String(userId)
  const sockets = seatSockets.get(key)
  if (!sockets) return 0

  sockets.delete(socketId)
  if (sockets.size === 0) {
    seatSockets.delete(key)
    return 0
  }
  return sockets.size
}

function getSeatSocketCount(userId) {
  return seatSockets.get(String(userId))?.size || 0
}

/**
 * 初始化 Socket.IO 服务
 * @param {http.Server} httpServer - HTTP 服务器实例
 * @param {EventEmitter} eventEmitter - 全局事件发射器（用于断开连接时自动释放会话）
 * @returns {Server} Socket.IO 实例
 */
function initializeSocket(httpServer, eventEmitter) {
  io = new Server(httpServer, {
    cors: {
      // 局域网部署会通过不同 IP/端口访问客服平台，Socket.IO 握手不限制 Origin。
      origin: true,
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingInterval: 25000,                    // 心跳检测间隔
    pingTimeout: 60000                      // 心跳超时时间
  })

  // ========== 连接认证中间件 ==========
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token

      if (!token) {
        return next(new Error('未提供认证令牌'))
      }

      // 去掉 Bearer 前缀
      const tokenStr = token.startsWith('Bearer ') ? token.slice(7) : token

      // 验证 JWT
      const decoded = jwt.verify(tokenStr, EFFECTIVE_JWT_SECRET)

      // 将用户信息挂载到 socket 上
      socket.userId = decoded.userId || decoded.id
      socket.username = decoded.username
      socket.role = decoded.role

      next()
    } catch (err) {
      console.error('[WebSocket] 认证失败:', err.message)
      next(new Error('认证失败: ' + err.message))
    }
  })

  // ========== 连接事件处理 ==========
  io.on('connection', (socket) => {
    console.log(`[WebSocket] 用户已连接: ${socket.username} (ID: ${socket.userId}, 角色: ${socket.role})`)

    // 加入个人房间（确保多设备登录都能收到消息）
    const userRoom = ROOMS.userRoom(socket.userId)
    socket.join(userRoom)

    // 如果是坐席或主管，也加入公共池房间（用于接收未分配会话的消息）
    if (isSeatRole(socket.role)) {
      addSeatSocket(socket.userId, socket.id)

      socket.join(ROOMS.PUBLIC_POOL)
      socket.join(ROOMS.AI_SELF_POOL)
      socket.join(ROOMS.PENDING_HUMAN_POOL)
      console.log(`[WebSocket] ${socket.username} 已加入公共池/AI自助池/待人工池房间`)

      // 更新坐席在线状态
      poolService.updateSeatStatus(socket.userId, SEAT_STATUS.ONLINE).catch(err =>
        console.error('[WebSocket] 更新坐席状态失败:', err.message)
      )
    }

    // 客户端请求加入指定会话房间
    socket.on('join_conversation', async (conversationId) => {
      try {
        // 权限校验：admin 可访问所有会话，agent/supervisor 只能访问分配给自己的会话
        if (socket.role !== 'admin') {
          const { sequelize } = require('../../config/database')
          const [rows] = await sequelize.query(
            `SELECT claimed_by, pool_type FROM conversations WHERE id = :conversationId LIMIT 1`,
            { replacements: { conversationId } }
          )

          if (rows.length === 0) {
            socket.emit('error', { message: `会话不存在: ${conversationId}` })
            return
          }

          // 会话未认领坐席时，允许 agent/supervisor 加入（公共池/待人工池接待场景）
          // 已认领则只允许认领的坐席加入（admin 除外）
          if (rows[0].claimed_by && rows[0].claimed_by !== socket.userId) {
            console.warn(`[WebSocket] ${socket.username} 无权访问会话 ${conversationId}（已被其他坐席认领）`)
            socket.emit('error', { message: '无权访问该会话' })
            return
          }
        }

        const roomName = `conversation:${conversationId}`
        socket.join(roomName)
        console.log(`[WebSocket] ${socket.username} 加入会话房间: ${roomName}`)
      } catch (err) {
        console.error('[WebSocket] 加入会话房间失败:', err.message)
        socket.emit('error', { message: '加入会话失败' })
      }
    })

    // 客户端离开会话房间
    socket.on('leave_conversation', (conversationId) => {
      const roomName = ROOMS.conversationRoom(conversationId)
      socket.leave(roomName)
      console.log(`[WebSocket] ${socket.username} 离开会话房间: ${roomName}`)
    })

    // 客户端标记已读
    socket.on('mark_read', (data) => {
      // 更新会话未读数
      if (data?.conversationId) {
        const { sequelize } = require('../../config/database')
        sequelize.query(
          `UPDATE conversations SET unread_count = 0 WHERE id = :id`,
          { replacements: { id: data.conversationId } }
        ).catch(err => console.error('[WebSocket] 标记已读失败:', err.message))
      }
      console.log(`[WebSocket] ${socket.username} 标记已读:`, data)
    })

    // ========== 断开连接 ==========
    socket.on('disconnect', async (reason) => {
      console.log(`[WebSocket] 用户已断开: ${socket.username} (原因: ${reason})`)

      if (isSeatRole(socket.role)) {
        const remainingSockets = removeSeatSocket(socket.userId, socket.id)
        if (remainingSockets > 0) {
          console.log(`[WebSocket] ${socket.username} disconnected, skip offline release because ${remainingSockets} socket(s) remain`)
          return
        }

        if (!shouldAutoReleaseOnOffline(socket.role)) {
          return
        }

        const key = String(socket.userId)
        const timer = setTimeout(async () => {
          seatOfflineTimers.delete(key)
          if (getSeatSocketCount(socket.userId) > 0) {
            console.log(`[WebSocket] ${socket.username} reconnected within grace period, skip offline release`)
            return
          }

          try {
            if (eventEmitter) {
              const released = await poolService.releaseOnSeatOffline(socket.userId, eventEmitter)
              if (released > 0) {
                console.log(`[WebSocket] ${socket.username} offline after ${seatOfflineGraceMs}ms grace, auto released ${released} conversation(s)`)
              }
            }
          } catch (err) {
            console.error('[WebSocket] 自动释放会话失败:', err.message)
          }
        }, seatOfflineGraceMs)
        seatOfflineTimers.set(key, timer)
        console.log(`[WebSocket] ${socket.username} has no active socket, scheduling offline release in ${seatOfflineGraceMs}ms`)
      }
    })

    // ========== 连接错误 ==========
    socket.on('error', (err) => {
      console.error(`[WebSocket] 连接错误 [${socket.username}]:`, err.message)
    })
  })

  console.log('[WebSocket] Socket.IO 服务已初始化')

  return io
}

/**
 * 获取 Socket.IO 实例（供 pushService 使用）
 * @returns {Server|null}
 */
function getIO() {
  return io
}

module.exports = {
  initializeSocket,
  getIO
}
