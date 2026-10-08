const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { QueryTypes } = require('sequelize')

const BRIDGE_SOURCE = 'desktop_bridge'

// 与 app.js 的 AVATAR_DIR / MEDIA_FILE_DIR 指向同一目录
const AVATAR_DIR = path.join(__dirname, '..', '..', 'public', 'avatars')
const MEDIA_DIR = path.join(__dirname, '..', '..', 'public', 'media-files')
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

function writeBase64Png({ dir, filename, base64Png, publicPrefix }) {
  if (!base64Png) return null
  let buffer
  try {
    buffer = Buffer.from(String(base64Png), 'base64')
  } catch {
    return null
  }
  if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) return null
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), buffer)
  return `${publicPrefix}/${filename}`
}

// 延迟加载消息主链路：它牵扯 models / configService / 翻译 / AI 回复等一大串依赖，
// 在桥接初始化时就把这一整棵依赖树拉起来没必要，也会让只想测本模块的用例被迫
// 加载全套（实测会让测试进程无法退出，跑满 30 秒超时）。
let _messagingService = null
function messagingService() {
  if (!_messagingService) {
    _messagingService = require('../messaging/messaging.service')
  }
  return _messagingService
}

/**
 * 把 Desktop Bridge 的 message.inbound 负载接进既有消息主链路。
 *
 * 复用而不是重写：`processIncomingMessage` 已经自带
 *   - channelMessageId 去重（重复时返回 { duplicate: true }，记 message.inbound_duplicate_skipped）
 *   - 会话查找/创建（键为 channel + account_id + user_id）
 *   - 翻译、AI 回复、实时推送、池路由
 * 所以这里只做三件事：校验账号绑定、把桥接负载映射成平台消息、透传去重结果。
 *
 * 关键映射约定
 * ------------
 * platformCustomerId -> userId（会话键的一部分，必须按客户区分，否则不同客户会串台）
 * platformConversationId -> 仅存进 rawData 供排查；后端不用它做会话匹配
 * direction：**只有客户发来的消息才标 inbound**。商家自己发出的与他人的消息标 outbound，
 *            因为 processIncomingMessage 对 direction==='inbound' 的文本消息会走 AI 回复流程，
 *            标错会导致商家自己的消息触发重复自动回复。
 */
function createInboundBridgeService({ sequelize, eventEmitter, logger = console } = {}) {
  if (!sequelize) throw new Error('sequelize is required')

  /**
   * 消息在页面上的真实时间，格式化为 MySQL 本地时间字符串。
   *
   * ⚠️ 两个坑都在这里避开：
   * 1. **不能用入库时刻（NOW()）**：界面按 created_at 排序，而一次采集会把整屏消息
   *    在同一秒内插进去，同秒只能按随机 UUID 兜底 → 顺序全乱。
   * 2. **不要直接传 Date 对象**给 replacements：入站走 UPDATE、出站走 INSERT，
   *    两条路径对 Date 的时区处理不一致，实测入站被存成了 UTC（16:35+08:00 存成 08:35），
   *    正好差 8 小时。自己格式化成本地时间字符串就没有歧义了。
   *
   * batchIndex 加到毫秒上：保留真实时间的同时，让同秒内的多条严格按页面顺序排列。
   */
  function resolveMessageTime(platformMessage) {
    const raw = platformMessage.clientTimestamp
    if (!raw) return null
    const base = new Date(raw)
    if (Number.isNaN(base.getTime())) return null

    const meta = platformMessage.rawData || {}
    const index = Number(meta.batchIndex)
    const when = new Date(base.getTime() + (Number.isFinite(index) && index > 0 ? index : 0))

    const pad = (value, width = 2) => String(value).padStart(width, '0')
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} `
      + `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
      + `.${pad(when.getMilliseconds(), 3)}`
  }

  /**
   * 保存节点截来的客户头像，并把 URL 回填到该客户的会话上。
   *
   * 飞鸽界面的头像没有 URL/路径（节点只有 name='头像'），只能由节点按 rect 截屏后
   * 以 base64 传上来。落盘到静态目录后，前端 <el-avatar :src="conversation.user_avatar">
   * 就能显示了。
   *
   * 注意：必须定义在工厂**内部**——放到模块级会拿不到闭包里的 sequelize
   * （踩过：报 "sequelize is not defined"，文件写成功但数据库没回填）。
   */
  async function saveAvatar({ customerKey, base64Png }) {
    if (!customerKey || !base64Png) return null
    const url = writeBase64Png({
      dir: AVATAR_DIR,
      filename: `feige-${customerKey}.png`,
      base64Png,
      publicPrefix: '/api/avatars'
    })
    if (!url) return null

    await sequelize.query(
      `UPDATE conversations SET user_avatar = :url, updated_at = NOW(3)
        WHERE channel = 'douyin' AND user_id = :customerKey`,
      { replacements: { url, customerKey } }
    )
    return url
  }

  /**
   * 保存客户表情/图片的截图，返回可访问 URL。
   *
   * 表情在元素树里只有占位文字（"表情"），只能由节点按 rect 截屏传上来。
   * 落盘后把 URL 写进消息 content —— 前端 MessageBubble 读 content.fileUrl
   * 且 message_type='image' 时才会渲染成图片。
   */
  async function saveSticker({ channelMessageId, base64Png }) {
    if (!channelMessageId || !base64Png) return null
    return writeBase64Png({
      dir: MEDIA_DIR,
      filename: `feige-sticker-${String(channelMessageId).slice(0, 24)}.png`,
      base64Png,
      publicPrefix: '/api/media-files/static'
    })
  }

  async function resolveAccount({ accountId, nodeId }) {
    if (!Number.isInteger(Number(accountId)) || Number(accountId) <= 0) {
      return { ok: false, status: 'rejected', code: 'ACCOUNT_NOT_FOUND' }
    }
    const rows = await sequelize.query(
      `SELECT a.id, a.channel, a.status, a.account_name,
              b.enabled AS binding_enabled, b.adapter_id, b.preferred_node_id
         FROM channel_accounts a
         LEFT JOIN desktop_bridge_bindings b ON b.channel_account_id = a.id
        WHERE a.id = :accountId`,
      { replacements: { accountId: Number(accountId) }, type: QueryTypes.SELECT }
    )
    const account = rows[0]
    if (!account) return { ok: false, status: 'rejected', code: 'ACCOUNT_NOT_FOUND' }
    if (account.status !== 'active') return { ok: false, status: 'rejected', code: 'ACCOUNT_INACTIVE' }
    if (!account.binding_enabled) return { ok: false, status: 'rejected', code: 'ACCOUNT_NOT_BOUND' }
    // 绑定了首选节点时，只接受该节点上报（防止多机抢同一账号）
    if (account.preferred_node_id && nodeId
        && Number(account.preferred_node_id) !== Number(nodeId)) {
      return { ok: false, status: 'rejected', code: 'NODE_NOT_BOUND' }
    }
    return { ok: true, account }
  }

  function toPlatformMessage(payload) {
    const observed = payload.platformPayload || {}
    const direction = observed.direction === 'in' ? 'inbound' : 'outbound'

    const mediaTypes = Array.isArray(payload.media) ? payload.media.map(item => item && item.type).filter(Boolean) : []
    const text = typeof payload.content === 'string' ? payload.content.trim() : ''
    // 媒体消息在界面上只有占位文字（如"表情"），这里给出可读占位，真实内容待截图通路补齐
    const fallback = observed.placeholder ? `[${observed.placeholder}]` : `[${mediaTypes[0] || 'media'}]`

    return {
      channel: payload.channel,
      accountId: Number(payload.accountId),
      channelMessageId: payload.channelMessageId,
      // 会话键：findOrCreateConversation 用 channel + account_id + user_id 匹配
      userId: payload.platformCustomerId,
      channelUserId: payload.platformCustomerId,
      userName: payload.userName,
      direction,
      messageType: payload.messageType || 'text',
      content: { text: text || fallback },
      clientTimestamp: payload.clientTimestamp,
      rawData: {
        source: BRIDGE_SOURCE,
        batchIndex: (payload.platformPayload && payload.platformPayload.batchIndex) || 0,
        platformConversationId: payload.platformConversationId || null,
        observedDirection: observed.direction || null,
        directionBasis: observed.directionBasis || null,
        readState: observed.readState || null,
        timePrecision: observed.timePrecision || null,
        contentDigest: observed.contentDigest || null,
        media: mediaTypes
      }
    }
  }

  /**
   * 网关的调用签名是 handle({ envelope, nodeId, nodeKey })——注意传的是**整个信封**，
   * 不是 payload。业务负载要从 envelope.payload 取。
   * 返回里的 errorCode/message 会被 gateway 放进 event.ack，节点侧能看到拒绝原因。
   */
  /**
   * 商家自己发出的消息（在客户端里手工回复的）单独落库。
   *
   * 不能走 processIncomingMessage：它把 direction 硬编码成 'inbound'
   * （messaging.service.js:594），会把商家消息写成语义相反的方向，进而污染会话、
   * 甚至触发 AI 回复。这里直接按 outbound 落库。
   */
  async function persistOutbound({ platformMessage, account }) {
    const service = messagingService()
    const conversationId = await service.findOrCreateConversation(platformMessage)

    const duplicates = await sequelize.query(
      `SELECT id FROM plat_messages
        WHERE channel = :channel AND account_id = :accountId AND channel_message_id = :channelMessageId
        LIMIT 1`,
      {
        replacements: {
          channel: platformMessage.channel,
          accountId: platformMessage.accountId,
          channelMessageId: platformMessage.channelMessageId,
          createdAt: resolveMessageTime(platformMessage)
        },
        type: QueryTypes.SELECT
      }
    )
    if (duplicates[0]) return { status: 'duplicate', conversationId }

    const messageId = randomUUID()
    const text = platformMessage.content && platformMessage.content.text ? platformMessage.content.text : ''
    await sequelize.query(
      `INSERT INTO plat_messages
         (id, conversation_id, channel, account_id, user_id, direction, sender_type, sender_id,
          message_type, content, channel_message_id, send_status, created_at, updated_at)
       VALUES (:id, :conversationId, :channel, :accountId, :userId, 'outbound', 'agent', NULL,
               :messageType, :content, :channelMessageId, 'sent', COALESCE(:createdAt, NOW(3)), NOW(3))`,
      {
        replacements: {
          id: messageId,
          conversationId,
          channel: platformMessage.channel,
          accountId: platformMessage.accountId,
          userId: platformMessage.userId,
          messageType: platformMessage.messageType || 'text',
          content: JSON.stringify({ text }),
          channelMessageId: platformMessage.channelMessageId,
          // 用页面上的真实时间：界面按 created_at 排序，用 NOW() 会让整批消息
          // 挤在同一秒、再按随机 UUID 兜底排序 → 顺序全乱
          createdAt: resolveMessageTime(platformMessage)
        }
      }
    )

    // 会话摘要与最近回复人（让"我发的"在列表里也体现出来）
    await sequelize.query(
      `UPDATE conversations
          SET last_message = :lastMessage, last_message_time = NOW(3),
              last_reply_by = 'agent', last_reply_time = NOW(3), updated_at = NOW(3)
        WHERE id = :conversationId`,
      {
        replacements: { conversationId, lastMessage: text.slice(0, 200) }
      }
    )

    return { status: 'processed', messageId, conversationId }
  }

  /**
   * 桥接账号进来的会话默认归 AI 池；只有明确需要人工时才留在待人工。
   * 已被人认领（claimed_by）的会话不动，避免把人工正在处理的会话抢回 AI。
   */
  async function ensureAiPool(conversationId) {
    if (!conversationId) return false
    const [result] = await sequelize.query(
      `UPDATE conversations
          SET pool_type = 'ai_self', conv_status = 'ai_serving', updated_at = NOW(3)
        WHERE id = :conversationId
          AND claimed_by IS NULL
          AND conv_status = 'pending_claim'`,
      { replacements: { conversationId } }
    )
    return Boolean(result && result.affectedRows)
  }

  async function handle({ envelope, nodeId, nodeKey } = {}) {
    const payload = envelope && envelope.payload

    if (!payload || typeof payload !== 'object') {
      logger.warn('[InboundBridge] 拒绝入站消息: 缺少 payload',
        'eventId=', envelope && envelope.eventId)
      return { status: 'rejected', errorCode: 'PAYLOAD_REQUIRED', message: 'envelope.payload is required' }
    }

    let account
    try {
      const resolved = await resolveAccount({ accountId: payload.accountId, nodeId })
      if (!resolved.ok) {
        logger.warn('[InboundBridge] 拒绝入站消息:', resolved.code,
          'accountId=', payload.accountId, 'nodeId=', nodeId)
        return { status: resolved.status, errorCode: resolved.code, message: resolved.code }
      }
      account = resolved.account
    } catch (error) {
      logger.error('[InboundBridge] 账号校验失败:', error.message)
      return { status: 'retryable_error', errorCode: 'ACCOUNT_LOOKUP_FAILED', message: error.message }
    }

    const platformMessage = toPlatformMessage(payload)

    // 节点只在头像内容变化时附带 avatarPng（base64），这里落盘并回填 URL。
    // 放在消息处理之后：会话行要先由消息链路创建出来。
    const avatarPng = payload.platformPayload && payload.platformPayload.avatarPng
    const stickerPng = payload.platformPayload && payload.platformPayload.stickerPng

    // 表情/图片消息：先把截图落盘，再把 URL 塞进 content，
    // 这样 processIncomingMessage 存下去的就是前端能渲染的地址。
    if (stickerPng) {
      const url = await saveSticker({
        channelMessageId: platformMessage.channelMessageId,
        base64Png: stickerPng
      }).catch(error => {
        logger.warn('[InboundBridge] 表情保存失败:', error.message)
        return null
      })
      if (url) {
        platformMessage.content = { ...platformMessage.content, fileUrl: url }
        platformMessage.messageType = 'image'
      }
    }

    try {
      // 商家自己发出的消息走独立入库路径（按 outbound 落库）。
      // 只有客户消息才进 processIncomingMessage —— 它把 direction 硬编码成 inbound。
      if (platformMessage.direction === 'outbound') {
        const result = await persistOutbound({ platformMessage, account })
        if (result.conversationId) await ensureAiPool(result.conversationId)
        return result
      }

      const result = await messagingService().processIncomingMessage(platformMessage, eventEmitter)
      if (result && result.duplicate) {
        return { status: 'duplicate', conversationId: result.conversationId }
      }
      // 桥接账号进来的会话默认归 AI 池（需要人工时才由池逻辑转待人工）
      if (platformMessage.conversationId) await ensureAiPool(platformMessage.conversationId)

      // 把 created_at 校正成页面上的真实时间。
      // 为什么不能依赖 processIncomingMessage 的返回值：它自己会写 created_at，
      // 而且是按 UTC 存的（实测 16:35+08:00 被存成 08:35，差 8 小时），
      // 但它的返回值不保证带 messageId，所以这里按 channelMessageId 定位。
      const when = resolveMessageTime(platformMessage)
      if (when && platformMessage.channelMessageId) {
        await sequelize.query(
          `UPDATE plat_messages SET created_at = :when
            WHERE channel = :channel AND account_id = :accountId
              AND channel_message_id = :channelMessageId`,
          {
            replacements: {
              when,
              channel: platformMessage.channel,
              accountId: platformMessage.accountId,
              channelMessageId: platformMessage.channelMessageId
            }
          }
        ).catch(error => logger.warn('[InboundBridge] 校正消息时间失败:', error.message))
      }
      if (avatarPng) {
        await saveAvatar({ customerKey: platformMessage.userId, base64Png: avatarPng })
          .catch(error => logger.warn('[InboundBridge] 头像保存失败:', error.message))
      }
      return {
        status: 'processed',
        messageId: result && result.messageId,
        conversationId: platformMessage.conversationId
      }
    } catch (error) {
      // 区分可重试与不可重试：数据库/网络类错误让节点重发，数据类错误直接拒绝
      const message = error && error.message ? error.message : String(error)
      logger.error('[InboundBridge] 落库失败:', message, 'accountId=', account && account.id)
      const retryable = /ECONNREFUSED|ETIMEDOUT|deadlock|LOCK_WAIT|SequelizeConnection|ER_LOCK/i.test(message)
      return {
        status: retryable ? 'retryable_error' : 'rejected',
        errorCode: retryable ? 'PERSIST_RETRYABLE' : 'PERSIST_FAILED',
        message: message.slice(0, 300)
      }
    }
  }

  return { handle, toPlatformMessage, resolveAccount, persistOutbound, ensureAiPool }
}

module.exports = { createInboundBridgeService, BRIDGE_SOURCE }
