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
  console.warn('[WebSocket] 警告：未配置 JWT_SECRET 环境变量，连接认证不可用')
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET

// 单例 Socket.IO 实例
let io = null

const seatSockets = new Map()
const seatOfflineTimers = new Map()
const seatOfflineGraceMs = Number.parseInt(process.env.SEAT_OFFLINE_GRACE_MS || '30000', 10)

function isSeatRole(role) {
  return role === 'agent' || role === 'admin'
}

function shouldAutoReleaseOnOffline(role) {
  return role === 'agent'
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
  io.use(async (socket, next) => {
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
      const User = require('../../models/User')
      const user = await User.findByPk(socket.userId, { attributes: ['id', 'username', 'role', 'status'] })
      if (!user || user.status !== 'active' || !['admin', 'agent'].includes(user.role)) return next(new Error('账号不可用'))
      socket.role = user.role
      socket.username = user.username

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

    // 如果是坐席，也加入公共池房间（用于接收未分配会话的消息）
    if (isSeatRole(socket.role)) {
      addSeatSocket(socket.userId, socket.id)

      if (socket.role === 'admin') {
        socket.join(ROOMS.PUBLIC_POOL)
        socket.join(ROOMS.AI_SELF_POOL)
        socket.join(ROOMS.PENDING_HUMAN_POOL)
      }
      console.log(`[WebSocket] ${socket.username} 已加入公共池/AI自助池/待人工池房间`)

      // Reconnecting must preserve an explicit offline choice.
      if (getSeatSocketCount(socket.userId) === 1) {
        ;(async () => {
          const { sequelize } = require('../../config/database')
          const [rows] = await sequelize.query('SELECT manual_offline, status FROM seat_status WHERE user_id = :id', { replacements: { id: socket.userId } })
          await poolService.updateSeatStatus(socket.userId, rows[0]?.manual_offline ? SEAT_STATUS.OFFLINE : rows[0]?.status === 'busy' ? SEAT_STATUS.BUSY : SEAT_STATUS.ONLINE)
        })().catch(error => console.error('[WebSocket] 更新坐席状态失败:', error.message))
      }
    }

    syncSeatAccountRooms(socket.userId).catch(error=>console.error('[WebSocket] 更新账号房间失败:',error.message))

    // 客户端请求加入指定会话房间
    socket.on('join_conversation', async (conversationId) => {
      try {
        // 权限校验：admin 可访问所有会话，agent 只能访问分配给自己的会话
        const { createWorkspaceService } = require('../conversation-pool/workspace.service')
        const { sequelize } = require('../../config/database')
        if (!await createWorkspaceService({sequelize}).canView(socket.userId,socket.role,conversationId)) {
          socket.emit('error',{message:'无权访问该会话'}); return
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
    socket.on('mark_read', async (data) => {
      // 更新会话未读数
      if (data?.conversationId) {
        const { sequelize } = require('../../config/database')
        sequelize.query(
          `UPDATE conversations c SET unread_count = 0 WHERE id = :id AND (:isAdmin = 1 OR ${require('../conversation-pool/workspacePolicy').agentVisibility('c','seatId')})`,
          { replacements: { id: data.conversationId, isAdmin: socket.role === 'admin' ? 1 : 0, seatId: socket.userId } }
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
            await poolService.updateSeatStatus(socket.userId, SEAT_STATUS.OFFLINE)
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

async function syncSeatAccountRooms(userId, { notify = false } = {}) {
  if (!io) return
  const { sequelize } = require('../../config/database')
  const [bindings] = await sequelize.query("SELECT account_id FROM seat_account_bindings WHERE seat_id=:userId AND status='active'", {replacements:{userId}})
  const sockets = await io.in(ROOMS.userRoom(userId)).fetchSockets()
  for (const socket of sockets) {
    if (socket.role !== 'agent') continue
    for (const room of socket.rooms) if (room.startsWith('account:') && room.endsWith(':ai')) await socket.leave(room)
    for (const binding of bindings) await socket.join(`account:${binding.account_id}:ai`)
    const workspace = require('../conversation-pool/workspace.service').createWorkspaceService({sequelize})
    for (const room of socket.rooms) if (room.startsWith('conversation:')
      && !await workspace.canView(userId,'agent',room.slice('conversation:'.length))) await socket.leave(room)
    if (notify) socket.emit('bindings_changed',{})
  }
}

module.exports = {
  initializeSocket,
  getIO,
  syncSeatAccountRooms,
  connectedSeatIds: () => Array.from(seatSockets.keys(), Number)
}
