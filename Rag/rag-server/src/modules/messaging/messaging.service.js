/**
 * Messaging 服务模块 - 消息收发与会话管理
 *
 * 核心职责：
 * 1. 接收渠道适配器标准化后的消息并入库
 * 2. 更新/创建会话（自动按 channel+accountId+channelUserId 查找或创建）
 * 3. 通过 EventEmitter 发射事件，由 pushService 推送给前端
 *
 * 架构约束：
 * - 消息入库后只发射事件，不直接调用 Socket.IO（解耦）
 * - 调用 ragService 生成推荐时走 service 层，不直接查知识库表
 */

const crypto = require('crypto')
const { sequelize } = require('../../config/database')
const { INTERNAL_EVENTS } = require('../websocket/events')
const avatarService = require('../../services/avatarService')
const nationalityService = require('../nationality/nationality.service')
const poolService = require('../conversation-pool/pool.service')
const { POOL_TYPE, CONV_STATUS, LAST_REPLY_BY } = require('../conversation-pool/constants')
const systemLogger = require('../../utils/systemLogger')
const { createCustomerOperationsService } = require('../customer-operations/customerOperations.service')
const { createCustomerOperationsEventHooks } = require('../customer-operations/customerOperations.events')
const { createCustomerOperationEventsRepository } = require('../customer-operations/customerOperationEvents.repository')

const customerOperationsHooks = createCustomerOperationsEventHooks({
  service: createCustomerOperationsService(),
  eventsRepository: createCustomerOperationEventsRepository(),
  logger: systemLogger
})

const MYSQL_LOCK_HASH_LENGTH = 40

function extractPhoneFromChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null
  const trimmed = chatId.trim()
  const cusMatch = trimmed.match(/^(\d+)@c\.us$/)
  if (cusMatch) return cusMatch[1]
  const barePhoneMatch = trimmed.match(/^\d{6,}$/)
  return barePhoneMatch ? trimmed : null
}

function onlyDigits(value) {
  return value ? String(value).replace(/\D/g, '') : ''
}

function isPhoneLikeDisplay(value) {
  if (!value || typeof value !== 'string') return false
  return onlyDigits(value).length >= 6 && /^[+\d\s().-]+$/.test(value.trim())
}

function formatPhoneForDisplay(phone, fallbackDisplay) {
  if (!phone) return null
  const digits = onlyDigits(phone)
  if (fallbackDisplay && isPhoneLikeDisplay(fallbackDisplay) && onlyDigits(fallbackDisplay) === digits) {
    return fallbackDisplay.trim()
  }
  if (/^1\d{10}$/.test(digits)) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return phone
}

function normalizeMessageTimestamp(message) {
  const rawTimestamp = message?.clientTimestamp || message?.serverTimestamp || Date.now()
  const timestamp = new Date(rawTimestamp)
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp
}

function toMysqlUtcDateTime(value) {
  const timestamp = value instanceof Date ? value : new Date(value)
  const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp
  return safeTimestamp.toISOString().slice(0, 19).replace('T', ' ')
}

function buildInboundDedupLockKey(message) {
  const channelMessageId = message?.channelMessageId
  if (!channelMessageId) return null
  const source = [
    message.channel || '',
    message.accountId === undefined || message.accountId === null ? 'null' : String(message.accountId),
    String(channelMessageId)
  ].join('|')
  return `inbound-msg-${crypto.createHash('sha256').update(source).digest('hex').slice(0, MYSQL_LOCK_HASH_LENGTH)}`
}

function buildConversationDedupLockKey(message) {
  const channelUserId = message?.channelUserId || message?.userId
  if (!message?.channel || !channelUserId) return null
  const source = [
    message.channel || '',
    message.accountId === undefined || message.accountId === null ? 'null' : String(message.accountId),
    String(channelUserId)
  ].join('|')
  return `conversation-user-${crypto.createHash('sha256').update(source).digest('hex').slice(0, MYSQL_LOCK_HASH_LENGTH)}`
}

async function withMysqlLocks(lockKeys, callback, timeoutSeconds = 60) {
  const keys = [...new Set((lockKeys || []).filter(Boolean))].sort()
  if (keys.length === 0) return callback()

  const transaction = await sequelize.transaction()
  const acquiredKeys = []

  try {
    for (const lockKey of keys) {
      const [rows] = await sequelize.query(
        'SELECT GET_LOCK(:lockKey, :timeoutSeconds) AS acquired',
        { replacements: { lockKey, timeoutSeconds }, transaction }
      )
      if (Number(rows?.[0]?.acquired) !== 1) {
        throw new Error(`获取入站消息幂等锁超时: ${lockKey}`)
      }
      acquiredKeys.push(lockKey)
    }

    return await callback()
  } finally {
    for (const lockKey of acquiredKeys.reverse()) {
      try {
        const [rows] = await sequelize.query(
          'SELECT RELEASE_LOCK(:lockKey) AS released',
          { replacements: { lockKey }, transaction }
        )
        if (Number(rows?.[0]?.released) !== 1) {
          console.warn('[Messaging] 释放入站消息幂等锁未成功:', lockKey)
        }
      } catch (err) {
        console.warn('[Messaging] 释放入站消息幂等锁失败:', err.message)
      }
    }

    try {
      await transaction.commit()
    } catch (err) {
      console.warn('[Messaging] 入站消息幂等锁事务提交失败:', err.message)
      try {
        await transaction.rollback()
      } catch {
        // ignore rollback failure after commit error
      }
    }
  }
}

async function findExistingInboundMessage(message) {
  if (!message?.channelMessageId) return null
  const [rows] = await sequelize.query(
    `SELECT id, conversation_id
     FROM plat_messages
     WHERE channel = :channel
       AND account_id <=> :accountId
       AND channel_message_id = :channelMessageId
       AND direction = 'inbound'
     LIMIT 1`,
    {
      replacements: {
        channel: message.channel,
        accountId: message.accountId || null,
        channelMessageId: message.channelMessageId
      }
    }
  )
  return rows[0] || null
}

function buildLastMessageText(messageType = 'text', content = {}) {
  let text = ''
  try {
    if (messageType && messageType !== 'text') {
      const typeLabel = { image: '图片', video: '视频', audio: '语音', file: '文件' }[messageType] || '文件'
      const detail = content.transcription || content.translatedText || content.text || content.caption ||
        content.fileName || content.filename || ''
      text = `[${typeLabel}] ${detail}`.trim()
    } else {
      text = content.translatedText || content.text || content.content || JSON.stringify(content)
    }
  } catch {
    text = String(content || '')
  }

  if (text.length > 200) {
    text = text.substring(0, 200) + '...'
  }
  return text
}

async function shouldReturnPublicTimeoutConversationToAi(conversationId) {
  const [rows] = await sequelize.query(
    `SELECT action, from_pool, to_pool, operator_type, reason
     FROM conversation_pool_logs
     WHERE conversation_id = :conversationId
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    { replacements: { conversationId } }
  )

  const latestLog = rows[0]
  if (!latestLog) return false

  const reason = String(latestLog.reason || '')
  const isAiSelfToPublic = latestLog.from_pool === POOL_TYPE.AI_SELF && latestLog.to_pool === POOL_TYPE.PUBLIC
  const isSystemMove = !latestLog.operator_type || latestLog.operator_type === 'system'
  const isNoReplyTimeout = reason.includes('AI回复后') ||
    reason.includes('客户超时未回复') ||
    reason.includes('客户未回复') ||
    reason.toLowerCase().includes('no reply')

  return isAiSelfToPublic && isSystemMove && isNoReplyTimeout
}

/**
 * 查找或创建会话
 *
 * 规则：同一渠道 + 同一账号 + 同一用户（channelUserId） = 同一会话
 * 如果会话不存在则创建新会话，初始 last_message 为消息文本摘要
 *
 * @param {Object} message - StandardMessage（含 channel, accountId, channelUserId, content 等）
 * @param {Object} options - { skipRouting: boolean } 是否跳过智能路由（历史导入时使用）
 * @returns {Promise<string>} conversationId (UUID)
 */
async function findOrCreateConversation(message, options = {}) {
  const { skipRouting = false } = options
  const channel = message.channel
  const accountId = message.accountId || null
  const channelUserId = message.channelUserId || message.userId || null

  // 提取消息文本摘要
  let lastMessageText = buildLastMessageText(message.messageType || 'text', message.content || {})
  // 截断为 200 字符
  if (lastMessageText.length > 200) {
    lastMessageText = lastMessageText.substring(0, 200) + '...'
  }

  // 用户显示名：优先用 channelUserId 的手机号
  const userName = message.userName || (channelUserId ? channelUserId.replace(/@.*$/, '') : '未知用户')

  // 构建会话查找 SQL：
  // - 如果 accountId 有值：精确匹配 channel + account_id + user_id
  // - 如果 accountId 为 null（webhook 未传 account_id）：放宽为 channel + user_id（匹配任意 account_id）
  //   避免因 account_id 缺失导致同一用户每次消息都创建新会话
  const accountCondition = accountId
    ? 'AND account_id <=> :accountId'
    : 'AND account_id IS NOT NULL'

  // 先查找已有会话（未归档的）
  const [existing] = await sequelize.query(
    `SELECT id, pool_type, conv_status, account_id, nationality_code FROM conversations
     WHERE channel = :channel
       ${accountCondition}
       AND user_id = :channelUserId
       AND conv_status != :archivedStatus
     ORDER BY account_id DESC, updated_at DESC
     LIMIT 1`,
    { replacements: { channel, accountId, channelUserId, archivedStatus: CONV_STATUS.ARCHIVED } }
  )

  if (existing.length > 0) {
    const existingConvId = existing[0].id
    const existingPoolType = existing[0].pool_type
    message.shouldInferNationality = !existing[0].nationality_code && !/@g\.us$/i.test(channelUserId || '')
    // 如果消息有 accountId 但会话没有（或不同），补全 account_id
    if (accountId && existing[0].account_id === null) {
      await sequelize.query(
        `UPDATE conversations SET account_id = :accountId, updated_at = NOW() WHERE id = :convId`,
        { replacements: { accountId, convId: existingConvId } }
      )
    }

    // 公共池会话收到新消息：
    // - AI 自助池客户无回复超时流出的会话，回 AI 自助池继续服务
    // - 其他公共池来源仍按原规则转回待人工池
    // 归档会话的复活在后面单独处理，这里只处理未归档的公共池会话
    if (!skipRouting && existingPoolType === POOL_TYPE.PUBLIC) {
      let targetPool = POOL_TYPE.PENDING_HUMAN
      let targetStatus = CONV_STATUS.PENDING_CLAIM
      let operatorName = '系统自动转池'
      let reason = '公共池会话收到新消息，转回待人工池'

      if (await shouldReturnPublicTimeoutConversationToAi(existingConvId)) {
        const config = await poolService.getPoolConfig()
        if (config.ai_self_pool_enabled !== false) {
          targetPool = POOL_TYPE.AI_SELF
          targetStatus = CONV_STATUS.AI_SERVING
          operatorName = '系统自动回流'
          reason = 'AI自助池客户超时未回复转出后再次收到新消息，回到AI自助池继续服务'
        }
      }

      await sequelize.query(
        `UPDATE conversations
         SET pool_type = :targetPool, conv_status = :targetStatus,
             claimed_by = NULL, claimed_at = NULL,
             updated_at = NOW()
         WHERE id = :convId`,
        { replacements: { targetPool, targetStatus, convId: existingConvId } }
      )

      // 记录池流转日志
      try {
        await poolService.logPoolAction({
          conversationId: existingConvId,
          action: 'pool_change',
          fromPool: POOL_TYPE.PUBLIC,
          toPool: targetPool,
          operatorType: 'system',
          operatorName,
          reason
        })
      } catch {
        // 日志失败不影响主流程
      }

      console.log(`[Messaging] 公共池会话 ${existingConvId} 收到新消息，转入 ${targetPool}`)
    }

    // 已有会话：异步补充头像（仅新消息触发，历史导入跳过）
    if (channel === 'whatsapp' && !skipRouting) {
      // 优先用会话已有的 account_id，fallback 到消息的 accountId
      const avatarAccountId = existing[0].account_id || accountId
      if (avatarAccountId) {
        avatarService.ensureAvatar(existingConvId, avatarAccountId, channelUserId).catch(() => {})
      }
    }
    return existingConvId
  }

  // accountId 为 null 时，先尝试宽松查找已归档会话（匹配任意 account_id）
  const archivedAccountCondition = accountId
    ? 'AND account_id <=> :accountId'
    : 'AND account_id IS NOT NULL'

  // 查找已归档的会话 — 历史导入时直接返回 ID 不复活；新消息时复活
  const [archived] = await sequelize.query(
    `SELECT id, account_id, nationality_code FROM conversations
     WHERE channel = :channel
       ${archivedAccountCondition}
       AND user_id = :channelUserId
       AND conv_status = :archivedStatus
     ORDER BY account_id DESC, updated_at DESC
     LIMIT 1`,
    { replacements: { channel, accountId, channelUserId, archivedStatus: CONV_STATUS.ARCHIVED } }
  )

  if (archived.length > 0) {
    const convId = archived[0].id
    message.shouldInferNationality = !archived[0].nationality_code && !/@g\.us$/i.test(channelUserId || '')

    // 历史导入：直接返回归档会话 ID，不复活（历史消息只是补充数据，不代表客户活跃）
    if (skipRouting) {
      return convId
    }

    // 如果消息有 accountId 但会话没有（或不同），复活时补全 account_id
    const effectiveAccountId = accountId || archived[0].account_id

    // 新消息：复活旧会话：归档 → 待人工池
    await sequelize.query(
      `UPDATE conversations
       SET pool_type = :pendingHuman, conv_status = :pendingClaim,
           status = 'open', claimed_by = NULL, claimed_at = NULL,
           account_id = :accountId,
           updated_at = NOW()
       WHERE id = :convId`,
      { replacements: { pendingHuman: POOL_TYPE.PENDING_HUMAN, pendingClaim: CONV_STATUS.PENDING_CLAIM, accountId: effectiveAccountId, convId } }
    )

    // 记录复活日志
    try {
      await poolService.logPoolAction({
        conversationId: convId,
        action: 'revive',
        fromPool: null,
        toPool: POOL_TYPE.PENDING_HUMAN,
        operatorType: 'system',
        operatorName: '系统自动复活',
        reason: '归档会话收到新消息，自动复活到待人工池'
      })
    } catch {
      // 日志失败不影响主流程
    }

    // 复活后异步获取头像
    if (channel === 'whatsapp' && !skipRouting && effectiveAccountId) {
      avatarService.ensureAvatar(convId, effectiveAccountId, channelUserId).catch(() => {})
    }

    console.log(`[Messaging] 归档会话 ${convId} 收到新消息，自动复活到待人工池`)
    return convId
  }

  // 创建新会话 — 智能路由 vs 历史导入
  const newConvId = crypto.randomUUID()
  let poolType = POOL_TYPE.AI_SELF
  let convStatus = CONV_STATUS.AI_SERVING
  let conversationStatus = 'open'
  let routeReason = '历史消息导入，默认AI自助池'

  if (skipRouting) {
    // History import only backfills data; classify the conversation after all messages are stored.
    poolType = POOL_TYPE.PUBLIC
    convStatus = CONV_STATUS.ARCHIVED
    conversationStatus = 'closed'
    routeReason = '历史消息导入，默认归档，导入完成后按最新消息归类'
    // 历史导入：不触发路由，创建后由 importHistoryMessages 统一处理归档
    console.log(`[Messaging] 历史导入创建会话（跳过路由）: ${channelUserId}`)
  } else {
    // 新消息：触发智能路由
    // 路由规则：老客户→待人工池，新客户复杂问题→待人工池，新客户简单问题→AI自助池
    try {
      const routerService = require('../conversation-pool/conversation-router.service')
      const routeResult = await routerService.routeNewConversation(message)
      poolType = routeResult.poolType
      convStatus = routeResult.convStatus
      routeReason = routeResult.reason
      console.log(`[Messaging] 新会话路由: ${poolType} (${routeReason})`)
    } catch (err) {
      // 路由异常 → 安全降级到待人工池
      poolType = POOL_TYPE.PENDING_HUMAN
      convStatus = CONV_STATUS.PENDING_CLAIM
      routeReason = '路由异常，安全降级到待人工池'
      console.error('[Messaging] 路由判断失败，安全降级到待人工池:', err.message)
    }
  }

  await sequelize.query(
    `INSERT INTO conversations
      (id, channel, account_id, user_id, user_name, agent_id,
       pool_type, conv_status,
       last_message, last_message_time, unread_count, status,
       last_reply_by, last_reply_time,
       created_at, updated_at)
     VALUES (:conversationId, :channel, :accountId, :channelUserId, :userName,
             NULL,
             :poolType, :convStatus,
             NULL, NULL, 0, :conversationStatus,
             NULL, NULL,
             NOW(), NOW())`,
    {
      replacements: {
        conversationId: newConvId,
        channel, accountId, channelUserId, userName,
        poolType, convStatus, conversationStatus
      }
    }
  )
  message.shouldInferNationality = !/@g\.us$/i.test(channelUserId || '')

  // Sequelize/MySQL 的 INSERT 返回结构在不同版本里不稳定；只要 SQL 没抛错就视为创建成功。
  try {
    await poolService.logPoolAction({
      conversationId: newConvId,
      action: 'pool_change',
      fromPool: null,
      toPool: poolType,
      operatorType: 'system',
      operatorName: '智能路由',
      reason: routeReason
    })
  } catch {
    // 日志记录失败不影响主流程
  }

  // 异步获取联系人头像（不阻塞消息处理流程）
  if (channel === 'whatsapp' && !skipRouting) {
    avatarService.ensureAvatar(newConvId, accountId, channelUserId).catch(err => {
      console.warn(`[Messaging] 头像获取失败 convId=${newConvId}:`, err.message)
    })
  }

  return newConvId
}

/**
 * 处理收到的渠道消息（入口方法）
 *
 * 渠道适配器（如 WhatsApp Webhook）收到消息并标准化后调用此方法：
 *   const messagingService = require('./modules/messaging/messaging.service')
 *   messagingService.processIncomingMessage(platformMessage)
 *
 * 流程：
 * 1. 查找或创建会话（自动关联 conversationId）
 * 2. 存储消息到 plat_messages 表
 * 3. 更新会话的 last_message / last_message_time / unread_count
 * 4. 发射 'newMessage' 事件 → pushService 推送给坐席
 *
 * @param {Object} message - 标准化的 PlatformMessage 对象
 * @param {EventEmitter} eventEmitter - 全局事件发射器
 * @returns {Promise<Object>} 存储后的消息对象
 */
async function processIncomingMessage(message, eventEmitter) {
  const inboundDedupLockKey = buildInboundDedupLockKey(message)
  const conversationDedupLockKey = buildConversationDedupLockKey(message)
  return withMysqlLocks(
    [conversationDedupLockKey, inboundDedupLockKey],
    () => processIncomingMessageLocked(message, eventEmitter)
  )
}

async function processIncomingMessageLocked(message, eventEmitter) {
  try {
    if (message.channelMessageId) {
      const existingMessage = await findExistingInboundMessage(message)
      if (existingMessage) {
        message.conversationId = existingMessage.conversation_id
        systemLogger.info('message.inbound_duplicate_skipped', {
          messageId: existingMessage.id,
          conversationId: existingMessage.conversation_id,
          channel: message.channel,
          accountId: message.accountId || null,
          channelMessageId: message.channelMessageId || null
        })
        return {
          duplicate: true,
          id: existingMessage.id,
          conversationId: existingMessage.conversation_id,
          channel: message.channel,
          accountId: message.accountId,
          channelMessageId: message.channelMessageId
        }
      }
    }

    // 1. 查找或创建会话（如果 message.conversationId 为空）
    if (!message.conversationId) {
      message.conversationId = await findOrCreateConversation(message)
    }

    // 1.5 翻译检测：对入站文本消息检测语言，非中文自动翻译
    // 重构后的数据结构：content.text = 客户原文（永不变），content.translatedText = 中文译文
    // 这样下游所有读取 content.text 的地方拿到的都是原文，不再需要 originalText || queryText 的 hack
    const isInboundText = message.direction === 'inbound' && message.messageType === 'text'
    const textContent = message.content?.text || ''
    if (isInboundText && textContent.trim()) {
      try {
        const configService = require('../../services/configService')
        const translateModel = await configService.getConfig('llm_translate_model')
        const rawContextCount = await configService.getConfig('translation_context_message_count')
        const contextCount = Math.max(0, Math.min(parseInt(rawContextCount, 10) || 0, 10))
        const contextMessages = contextCount > 0
          ? await getConversationContext(message.conversationId, contextCount)
          : []
        console.log('[Messaging] 翻译模型:', translateModel, '上下文条数:', contextMessages.length, '文本:', textContent.substring(0, 100))
        const { processTranslation } = require('../../services/translationService')
        const result = await processTranslation(textContent, translateModel, 'qwen3.6-flash', {
          contextMessages
        })
        // text 始终存原文；译文移到 translatedText（仅翻译时存在）
        if (result.translated || result.translateFailed) {
          message.content = {
            ...message.content,
            text: result.originalText || textContent,
            translatedText: result.text,
            originalLang: result.originalLang || 'unknown',
            langLabel: result.langLabel || '未知语言',
            translated: true
          }
        }
        // 中文消息或翻译未改变原文时，content.text 保持不变（就是原文）
        console.log('[Messaging] 翻译结果:', result.translated ? `已翻译 (${result.langLabel}→中文)，原文保留在 text` : '中文无需翻译')
      } catch (transErr) {
        console.error('[Messaging] 翻译检测失败，使用原文:', transErr.message)
        console.error('[Messaging] 翻译错误详情:', transErr.stack?.substring(0, 300))
        // 翻译失败不阻塞消息处理
      }
    }

    // 2. 存储消息到 plat_messages 表
    const messageId = message.id || crypto.randomUUID()
    const messageTimestamp = normalizeMessageTimestamp(message)
    const messageDateTime = toMysqlUtcDateTime(messageTimestamp)
    await sequelize.query(
      `INSERT INTO plat_messages
        (id, conversation_id, channel, account_id, user_id, direction, sender_type, message_type, content, channel_message_id, send_status, created_at, updated_at)
       VALUES (:messageId, :conversationId, :channel, :accountId, :userId,
               'inbound', 'customer', :messageType, :content, :channelMessageId, 'received', :messageDateTime, :messageDateTime)`,
      {
        replacements: {
          messageId,
          conversationId: message.conversationId,
          channel: message.channel,
          accountId: message.accountId || null,
          userId: message.channelUserId || message.userId || null,
          messageType: message.messageType || 'text',
          content: JSON.stringify(message.content || {}),
          channelMessageId: message.channelMessageId || null,
          messageDateTime
        }
      }
    )
    void customerOperationsHooks.recordMessage({
      ...message,
      messageId,
      direction: 'inbound',
      senderType: 'customer',
      externalUserId: message.channelUserId || message.userId,
      timestamp: messageTimestamp,
      conversationId: message.conversationId
    })
    systemLogger.info('message.inbound_stored', {
      messageId,
      conversationId: message.conversationId,
      channel: message.channel,
      accountId: message.accountId || null,
      userId: systemLogger.maskValue(message.channelUserId || message.userId),
      messageType: message.messageType || 'text',
      channelMessageId: message.channelMessageId || null,
      messageDateTime
    })

    // 3. 提取消息文本摘要
    let lastMessageText = buildLastMessageText(message.messageType || 'text', message.content || {})
    if (lastMessageText.length > 200) {
      lastMessageText = lastMessageText.substring(0, 200) + '...'
    }

    // 4. 更新会话的最后消息、时间和未读数，同时更新最后回复方为客户
    await sequelize.query(
      `UPDATE conversations
       SET last_message = :lastMessage,
           last_message_time = :messageDateTime,
           last_reply_by = :replyBy,
           last_reply_time = :messageDateTime,
           unread_count = unread_count + 1
       WHERE id = :conversationId`,
      { replacements: { lastMessage: lastMessageText, messageDateTime, replyBy: LAST_REPLY_BY.CUSTOMER, conversationId: message.conversationId } }
    )

    // 仅会话国籍为空时执行推测；已有值不会进入服务，避免重复字典查询和语言处理。
    let shouldInferNationality = message.shouldInferNationality
    let nationalityInput = null
    if (shouldInferNationality === undefined) {
      const [conversationRows] = await sequelize.query(
        `SELECT channel, account_id, user_id, user_name, nationality_code
         FROM conversations WHERE id = :conversationId LIMIT 1`,
        { replacements: { conversationId: message.conversationId } }
      )
      nationalityInput = conversationRows[0] || null
      shouldInferNationality = Boolean(
        nationalityInput &&
        !nationalityInput.nationality_code &&
        !/@g\.us$/i.test(nationalityInput.user_id || '')
      )
    }
    if (shouldInferNationality) {
      try {
        await nationalityService.inferConversationNationality(message.conversationId, {
          ...(nationalityInput || {}),
          channel: nationalityInput?.channel || message.channel,
          account_id: nationalityInput?.account_id || message.accountId || null,
          user_id: nationalityInput?.user_id || message.channelUserId || message.userId || null,
          user_name: nationalityInput?.user_name || message.userName || null,
          nationality_code: null,
          content: message.content
        })
      } catch (nationalityError) {
        console.warn(`[Messaging] 国籍推测失败 conversationId=${message.conversationId}:`, nationalityError.message)
      }
    }

    // 5. 构造推送用的标准化消息体
    const pushMessage = {
      id: messageId,
      conversationId: message.conversationId,
      channel: message.channel,
      accountId: message.accountId,
      userId: message.channelUserId || message.userId,
      direction: 'inbound',
      senderType: 'customer',
      messageType: message.messageType || 'text',
      content: message.content,
      channelMessageId: message.channelMessageId,
      sendStatus: 'received',
      serverTimestamp: messageTimestamp.getTime()
    }

    // 6. 发射事件 → pushService 监听并推送给坐席
    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.NEW_MESSAGE, pushMessage)
      // 同时发射会话更新事件（附带完整会话数据，前端可插入新会话）
      const [convRow] = await sequelize.query(
        `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.user_avatar, c.agent_id,
                c.nationality_code, c.nationality_source, c.nationality_inferred_at,
                nd.name_zh AS nationality_name, nd.name_en AS nationality_name_en,
                c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
                c.last_reply_by, c.last_reply_time,
                c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at
         FROM conversations c
         LEFT JOIN nationality_dictionary nd ON nd.country_code = c.nationality_code
         WHERE c.id = :id LIMIT 1`,
        { replacements: { id: message.conversationId } }
      )
      const convData = convRow[0] || null
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: message.conversationId,
        conversationId: message.conversationId,
        type: 'new_message',
        lastMessage: lastMessageText,
        ...convData,
        customer_phone: formatPhoneForDisplay(extractPhoneFromChatId(convData?.user_id), convData?.user_name)
      })
      console.log(`[Messaging] 新消息已入库并发射事件，会话: ${message.conversationId}`)
    }

    return pushMessage
  } catch (error) {
    systemLogger.error('message.inbound_failed', {
      conversationId: message?.conversationId,
      channel: message?.channel,
      accountId: message?.accountId || null,
      channelMessageId: message?.channelMessageId || null,
      error
    })
    console.error('[Messaging] 处理收到的消息失败:', error.message)
    throw error
  }
}

/**
 * 发送消息（从工作台坐席发送）
 *
 * @param {Object} message - { conversationId, content, messageType, agentId }
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<Object>}
 */
async function sendOutboundMessage(message, eventEmitter) {
  try {
    // 1. 存储消息
    const messageId = message.id || crypto.randomUUID()
    await sequelize.query(
      `INSERT INTO plat_messages
        (id, conversation_id, channel, account_id, user_id, direction, sender_type, sender_id, message_type, content, send_status, created_at, updated_at)
       SELECT :messageId, :conversationId, c.channel, :accountId, c.user_id, 'outbound', 'agent', :senderId,
              :messageType, :content, :sendStatus, NOW(), NOW()
       FROM conversations c WHERE c.id = :conversationId`,
      {
        replacements: {
          messageId,
          conversationId: message.conversationId,
          accountId: message.accountId || null,
          senderId: message.agentId || null,
          messageType: message.messageType || 'text',
          content: JSON.stringify(message.content || {}),
          sendStatus: message.sendStatus || 'received'
        }
      }
    )
    void customerOperationsHooks.recordMessage({
      ...message,
      messageId,
      direction: 'outbound',
      senderType: 'agent',
      externalUserId: message.channelUserId || message.userId,
      timestamp: new Date(),
      conversationId: message.conversationId
    })
    systemLogger.info('message.outbound_stored', {
      messageId,
      conversationId: message.conversationId,
      accountId: message.accountId || null,
      senderId: message.agentId || null,
      messageType: message.messageType || 'text',
      senderType: 'agent'
    })

    // 2. 提取消息文本摘要
    let lastMessageText = ''
    try {
      const content = message.content || {}
      if (message.messageType && message.messageType !== 'text') {
        const typeLabel = { image: '图片', video: '视频', file: '文件' }[message.messageType] || '文件'
        lastMessageText = `[${typeLabel}] ${content.fileName || content.filename || content.caption || ''}`.trim()
      } else {
        lastMessageText = content.translatedText || content.text || content.content || JSON.stringify(content)
      }
    } catch {
      lastMessageText = String(message.content || '')
    }
    lastMessageText = buildLastMessageText(message.messageType || 'text', message.content || {})
    if (lastMessageText.length > 200) {
      lastMessageText = lastMessageText.substring(0, 200) + '...'
    }

    // 3. 更新会话最后消息和时间
    await sequelize.query(
      `UPDATE conversations
       SET last_message = :lastMessage, last_message_time = NOW(),
           last_reply_by = :replyBy, last_reply_time = NOW()
       WHERE id = :conversationId`,
      { replacements: { lastMessage: lastMessageText, replyBy: LAST_REPLY_BY.AGENT, conversationId: message.conversationId } }
    )

    // 4. 发射消息状态事件 + 新消息事件
    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.MESSAGE_UPDATE, {
        conversationId: message.conversationId,
        messageId,
        sendStatus: message.sendStatus || 'received'
      })
      eventEmitter.emit(INTERNAL_EVENTS.NEW_MESSAGE, {
        id: messageId,
        conversationId: message.conversationId,
        direction: 'outbound',
        senderType: 'agent',
        messageType: message.messageType || 'text',
        content: message.content || {},
        sendStatus: message.sendStatus || 'received',
        serverTimestamp: Date.now()
      })
    }

    return { success: true, messageId }
  } catch (error) {
    console.error('[Messaging] 发送消息失败:', error.message)
    throw error
  }
}

/**
 * 分配会话给坐席
 *
 * @param {string} conversationId
 * @param {number} agentId
 * @param {number|null} previousAgentId - 转接时的原坐席
 * @param {EventEmitter} eventEmitter
 */
async function assignConversation(conversationId, agentId, previousAgentId, eventEmitter) {
  try {
    // 同时更新 agent_id（兼容旧字段）和池字段
    await sequelize.query(
      `UPDATE conversations
       SET agent_id = :agentId,
           pool_type = :poolType,
           conv_status = :convStatus,
           claimed_by = :agentId,
           claimed_at = NOW()
       WHERE id = :conversationId`,
      {
        replacements: {
          agentId,
          poolType: POOL_TYPE.PRIVATE,
          convStatus: CONV_STATUS.HANDLING,
          conversationId
        }
      }
    )

    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        conversationId,
        agentId,
        previousAgentId,
        type: previousAgentId ? 'transferred' : 'assigned'
      })
    }

    return { success: true }
  } catch (error) {
    console.error('[Messaging] 分配会话失败:', error.message)
    throw error
  }
}

/**
 * 获取会话上下文历史（用于 RAG 推荐生成）
 *
 * 从 plat_messages 表查询会话的最近消息，格式化为 LLM 可用的消息数组。
 * 只有实际发送/接收的消息才会进入上下文，AI 推荐结果不会保存到表中。
 *
 * @param {string} conversationId - 会话 ID
 * @param {number} limit - 最多取最近多少条消息
 * @returns {Promise<Array<{role: string, content: string, senderType: string}>>}
 */
async function getConversationContext(conversationId, limit = 20) {
  try {
    const [rows] = await sequelize.query(
      `SELECT direction, sender_type, message_type, content, created_at
       FROM plat_messages
       WHERE conversation_id = :conversationId
       ORDER BY created_at DESC
       LIMIT :limit`,
      { replacements: { conversationId, limit } }
    )

    // 反转为时间正序（最旧在前，最新在后）
    const sorted = rows.reverse()

    // 转换为 LLM 消息格式
    const messages = []
    for (const row of sorted) {
      let text = ''
      try {
        const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content
        // LLM 上下文直接使用客户原文（重构后 content.text 即原文）
        text = content.text || content.content || JSON.stringify(content)
      } catch {
        text = typeof row.content === 'string' ? row.content : JSON.stringify(row.content)
      }

      const senderType = row.sender_type || (row.direction === 'inbound' ? 'customer' : 'agent')
      messages.push({
        role: row.direction === 'inbound' ? 'user' : 'assistant',
        content: text,
        senderType
      })
    }

    return messages
  } catch (error) {
    console.error('[Messaging] 获取会话上下文失败:', error.message)
    return []
  }
}

/**
 * 归档单个会话（内部辅助函数）
 * @param {string} convId - 会话 ID
 * @param {Date} lastMsgTime - 最后消息时间
 */
async function archiveConversationById(convId, lastMsgTime) {
  try {
    const [currentRows] = await sequelize.query(
      `SELECT pool_type FROM conversations WHERE id = :convId LIMIT 1`,
      { replacements: { convId } }
    )
    const fromPool = currentRows[0]?.pool_type || POOL_TYPE.AI_SELF

    const [result] = await sequelize.query(
      `UPDATE conversations
       SET pool_type = :archivePool,
           conv_status = :archived,
           status = 'closed',
           claimed_by = NULL,
           claimed_at = NULL,
           updated_at = NOW()
       WHERE id = :convId AND conv_status != :archived`,
      { replacements: { archivePool: POOL_TYPE.PUBLIC, archived: CONV_STATUS.ARCHIVED, convId } }
    )
    // 只有实际归档了（affectedRows > 0）才写日志，避免重复同步产生重复日志
    if (result.affectedRows === 0) return

    await poolService.logPoolAction({
      conversationId: convId,
      action: 'auto_archive',
      fromPool,
      toPool: null,
      operatorType: 'system',
      operatorName: '历史导入自动归档',
      reason: `最后消息 ${lastMsgTime.toISOString()} 超过 24 小时，自动归档`
    })
    console.log(`[Messaging] 历史会话 ${convId} 已归档（最后消息: ${lastMsgTime.toISOString()}）`)
  } catch (err) {
    console.error(`[Messaging] 归档会话 ${convId} 失败:`, err.message)
  }
}

/**
 * 批量导入历史消息（从 WAHA 拉取后调用）
 *
 * 核心原则：
 * 1. 历史导入不触发智能路由（skipRouting=true）
 * 2. 导入后自动归档最后一条消息 > 24 小时的旧会话
 * 3. 归档会话收到新消息时自动复活到待人工池（由 findOrCreateConversation 处理）
 *
 * @param {Array<Object>} messages - StandardMessage 数组（已按时间排序）
 * @param {EventEmitter} eventEmitter - 可选
 * @returns {Promise<Object>} { imported: number, skipped: number, archived: number, conversations: Array }
 */
function parseHistoryContent(content) {
  try {
    return typeof content === 'string' ? JSON.parse(content) : (content || {})
  } catch {
    return typeof content === 'string' ? { text: content } : {}
  }
}

function buildHistoryMediaRepairContent(existingContent, nextContent = {}) {
  if (!nextContent?.hasMedia) return null
  const nextUrl = nextContent.fileUrl || nextContent.url
  if (!nextUrl) return null

  const existing = parseHistoryContent(existingContent)
  const existingUrl = existing.fileUrl || existing.url
  if (existingUrl && existing.downloadStatus !== 'failed') return null

  const repaired = { ...existing, ...nextContent }
  if (!nextContent.text && existing.text) repaired.text = existing.text

  for (const key of ['translated', 'translatedText', 'originalLang', 'langLabel', 'quotedMsg']) {
    if (existing[key] !== undefined && nextContent[key] === undefined) {
      repaired[key] = existing[key]
    }
  }

  return repaired
}

function getLastReplyByFromHistoryMessage(message) {
  if (!message) return null
  if (message.direction === 'inbound') return LAST_REPLY_BY.CUSTOMER
  return message.sender_type === 'ai' ? LAST_REPLY_BY.AI : LAST_REPLY_BY.AGENT
}

async function getLatestConversationMessage(conversationId) {
  const [rows] = await sequelize.query(
    `SELECT direction, sender_type, created_at
     FROM plat_messages
     WHERE conversation_id = :conversationId
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    { replacements: { conversationId } }
  )
  return rows[0] || null
}

async function moveHistoryConversationToPendingHuman(conversationId, latestMessage, eventEmitter) {
  const latestTime = latestMessage?.created_at ? toMysqlUtcDateTime(latestMessage.created_at) : null
  const [currentRows] = await sequelize.query(
    `SELECT pool_type FROM conversations WHERE id = :conversationId LIMIT 1`,
    { replacements: { conversationId } }
  )
  const fromPool = currentRows[0]?.pool_type || POOL_TYPE.PUBLIC

  const [result] = await sequelize.query(
    `UPDATE conversations
     SET pool_type = :pendingHuman,
         conv_status = :pendingClaim,
         status = 'open',
         claimed_by = NULL,
         claimed_at = NULL,
         last_reply_by = :replyBy,
         last_reply_time = COALESCE(:latestTime, last_reply_time),
         updated_at = NOW()
     WHERE id = :conversationId`,
    {
      replacements: {
        pendingHuman: POOL_TYPE.PENDING_HUMAN,
        pendingClaim: CONV_STATUS.PENDING_CLAIM,
        replyBy: LAST_REPLY_BY.CUSTOMER,
        latestTime,
        conversationId
      }
    }
  )

  if (result.affectedRows === 0) return false

  await poolService.logPoolAction({
    conversationId,
    action: 'pool_change',
    fromPool,
    toPool: POOL_TYPE.PENDING_HUMAN,
    operatorType: 'system',
    operatorName: '历史导入归类',
    reason: '历史导入发现24小时内客户最后发言，转待人工确认'
  })

  if (eventEmitter) {
    eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
      id: conversationId,
      conversationId,
      type: 'pool_change',
      fromPool,
      toPool: POOL_TYPE.PENDING_HUMAN,
      operatorType: 'system',
      reason: '历史导入发现24小时内客户最后发言，转待人工确认'
    })
  }

  return true
}

async function updateHistoryLastReply(conversationId, latestMessage) {
  const lastReplyBy = getLastReplyByFromHistoryMessage(latestMessage)
  if (!lastReplyBy) return

  await sequelize.query(
    `UPDATE conversations
     SET last_reply_by = :lastReplyBy,
         last_reply_time = :lastReplyTime
     WHERE id = :conversationId`,
    {
      replacements: {
        lastReplyBy,
        lastReplyTime: toMysqlUtcDateTime(latestMessage.created_at),
        conversationId
      }
    }
  )
}

async function classifyHistoryConversation(conversationId, cutoffTime, eventEmitter, options = {}) {
  const { preserveActiveAiSelf = false } = options
  const [conversationRows] = await sequelize.query(
    `SELECT pool_type, conv_status, last_reply_by
     FROM conversations
     WHERE id = :conversationId
     LIMIT 1`,
    { replacements: { conversationId } }
  )
  const conversation = conversationRows[0]
  if (!conversation) return { archived: false, pendingHuman: false }

  const isHistoryArchiveCandidate = conversation.conv_status === CONV_STATUS.ARCHIVED
  const isLegacyAiImportResidual = conversation.pool_type === POOL_TYPE.AI_SELF &&
    conversation.conv_status === CONV_STATUS.AI_SERVING &&
    conversation.last_reply_by == null

  if (!isHistoryArchiveCandidate && !isLegacyAiImportResidual) {
    return { archived: false, pendingHuman: false }
  }

  const latestMessage = await getLatestConversationMessage(conversationId)
  if (!latestMessage) {
    if (preserveActiveAiSelf && isLegacyAiImportResidual) {
      return { archived: false, pendingHuman: false, preservedAiSelf: true }
    }
    await archiveConversationById(conversationId, new Date(), {
      reason: '历史导入未发现消息，自动归档'
    })
    return { archived: true, pendingHuman: false, preservedAiSelf: false }
  }

  await updateHistoryLastReply(conversationId, latestMessage)

  if (preserveActiveAiSelf && isLegacyAiImportResidual) {
    return { archived: false, pendingHuman: false, preservedAiSelf: true }
  }

  const latestAt = new Date(latestMessage.created_at)
  if (Number.isNaN(latestAt.getTime()) || latestAt < cutoffTime) {
    await archiveConversationById(conversationId, latestAt)
    return { archived: true, pendingHuman: false, preservedAiSelf: false }
  }

  if (latestMessage.direction === 'inbound') {
    const moved = await moveHistoryConversationToPendingHuman(conversationId, latestMessage, eventEmitter)
    return { archived: false, pendingHuman: moved, preservedAiSelf: false }
  }

  await archiveConversationById(conversationId, latestAt)
  return { archived: true, pendingHuman: false, preservedAiSelf: false }
}

async function importHistoryMessages(messages, eventEmitter, options = {}) {
  const { forceUpdate = false, preserveActiveAiSelf = false } = options
  let imported = 0
  let skipped = 0
  let updated = 0
  // 跟踪所有受影响的会话：convId → { lastMsgTimestamp, channel, accountId, channelUserId }
  const affectedConversations = new Map()

  for (const msg of messages) {
    try {
      const msgTimestamp = normalizeMessageTimestamp(msg)
      const msgDateTime = toMysqlUtcDateTime(msgTimestamp)

      // 幂等：检查 channelMessageId 是否已存在
      if (msg.channelMessageId) {
        const [existing] = await sequelize.query(
          `SELECT id, content FROM plat_messages WHERE channel_message_id = :channelMessageId LIMIT 1`,
          { replacements: { channelMessageId: msg.channelMessageId } }
        )
        if (existing.length > 0) {
          const mediaRepairContent = buildHistoryMediaRepairContent(existing[0].content, msg.content || {})
          if (forceUpdate) {
            // 强制更新：覆盖 content（修复引用回复等格式问题）
            const newContent = JSON.stringify(msg.content || {})
            await sequelize.query(
              `UPDATE plat_messages SET content = :content, updated_at = NOW() WHERE id = :id`,
              { replacements: { content: newContent, id: existing[0].id } }
            )
            updated++
          } else if (mediaRepairContent) {
            await sequelize.query(
              `UPDATE plat_messages SET content = :content, updated_at = NOW() WHERE id = :id`,
              { replacements: { content: JSON.stringify(mediaRepairContent), id: existing[0].id } }
            )
            updated++
          } else {
            skipped++
          }
          // 消息已存在，但仍需跟踪会话以便后续归档检查
          const convId = await findOrCreateConversation(msg, { skipRouting: true })
          const tracked = affectedConversations.get(convId)
          if (!tracked || msgTimestamp > tracked.lastMsgTimestamp) {
            affectedConversations.set(convId, {
              lastMsgTimestamp: msgTimestamp,
              channel: msg.channel,
              accountId: msg.accountId || null,
              channelUserId: msg.channelUserId || msg.userId || null
            })
          }
          continue
        }
      }

      // 每条消息按其 channelUserId 查找/创建对应会话（不同联系人是不同会话）
      // skipRouting=true：历史导入不触发智能路由
      const convId = await findOrCreateConversation(msg, { skipRouting: true })

      // 入库
      const histDirection = msg.direction || 'inbound'
      const histSenderType = histDirection === 'inbound' ? 'customer' : 'agent'
      await sequelize.query(
        `INSERT INTO plat_messages
          (id, conversation_id, channel, account_id, user_id, direction, sender_type, message_type, content, channel_message_id, send_status, created_at, updated_at)
         VALUES (UUID(), :conversationId, :channel, :accountId, :userId,
                 :direction, :senderType, :messageType, :content, :channelMessageId, 'received', :timestamp, :timestamp)`,
        {
          replacements: {
            conversationId: convId,
            channel: msg.channel,
            accountId: msg.accountId || null,
            userId: msg.channelUserId || msg.userId || null,
            direction: histDirection,
            senderType: histSenderType,
            messageType: msg.messageType || 'text',
            content: JSON.stringify(msg.content || {}),
            channelMessageId: msg.channelMessageId || null,
            timestamp: msgDateTime
          }
        }
      )

      // 追踪每个会话的最后消息时间（保留最新的）
      const tracked = affectedConversations.get(convId)
      if (!tracked || msgTimestamp > tracked.lastMsgTimestamp) {
        affectedConversations.set(convId, {
          lastMsgTimestamp: msgTimestamp,
          channel: msg.channel,
          accountId: msg.accountId || null,
          channelUserId: msg.channelUserId || msg.userId || null
        })
      }

      imported++
    } catch (err) {
      console.error('[Messaging] 导入历史消息失败:', err.message)
      skipped++
    }
  }

  // ========== 批量更新所有受影响会话的 last_message ==========
  for (const [convId, info] of affectedConversations) {
    try {
      const [lastMsg] = await sequelize.query(
        `SELECT message_type, content, created_at FROM plat_messages
         WHERE conversation_id = :conversationId
         ORDER BY created_at DESC LIMIT 1`,
        { replacements: { conversationId: convId } }
      )
      if (lastMsg.length > 0) {
        let lastText = ''
        try {
          const content = typeof lastMsg[0].content === 'string' ? JSON.parse(lastMsg[0].content) : lastMsg[0].content
          lastText = buildLastMessageText(lastMsg[0].message_type || 'text', content)
        } catch {
          lastText = String(lastMsg[0].content || '')
        }
        if (lastText.length > 200) lastText = lastText.substring(0, 200) + '...'

        await sequelize.query(
          `UPDATE conversations SET last_message = :lastMessage, last_message_time = :lastTime WHERE id = :conversationId`,
          { replacements: { lastMessage: lastText, lastTime: toMysqlUtcDateTime(lastMsg[0].created_at), conversationId: convId } }
        )
      }
    } catch (err) {
      console.error(`[Messaging] 更新会话 ${convId} last_message 失败:`, err.message)
    }
  }

  // ========== 归档超过 24 小时无消息的旧会话 ==========
  const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000)
  let archivedCount = 0
  let pendingHumanCount = 0
  let preservedAiSelfCount = 0
  for (const [convId] of affectedConversations) {
    try {
      const result = await classifyHistoryConversation(convId, cutoffTime, eventEmitter, { preserveActiveAiSelf })
      if (result.archived) archivedCount++
      if (result.pendingHuman) pendingHumanCount++
      if (result.preservedAiSelf) preservedAiSelfCount++
    } catch (err) {
      console.error(`[Messaging] 历史导入会话 ${convId} 归类失败:`, err.message)
    }
  }

  // ========== 兜底扫描：归档所有 AI 自助池中超过 24h 的历史会话 ==========
  // 处理已有数据（修复前创建的会话）和未被消息跟踪到的会话
  try {
    const [staleConvs] = await sequelize.query(
      `SELECT c.id, c.last_message_time
       FROM conversations c
       WHERE c.pool_type = :aiPool
         AND c.conv_status != :archived
         AND c.last_message_time IS NOT NULL
         AND c.last_message_time < :cutoff`,
      {
        replacements: {
          aiPool: POOL_TYPE.AI_SELF,
          archived: CONV_STATUS.ARCHIVED,
          cutoff: cutoffTime.toISOString().slice(0, 19).replace('T', ' ')
        }
      }
    )
    for (const conv of staleConvs) {
      // 跳过已在上面处理过的
      if (affectedConversations.has(conv.id)) continue
      await archiveConversationById(conv.id, new Date(conv.last_message_time))
      archivedCount++
    }
    if (staleConvs.length > 0) {
      console.log(`[Messaging] 兜底扫描归档 ${staleConvs.length} 个 AI 自助池旧会话`)
    }
  } catch (err) {
    console.error('[Messaging] 兜底归档扫描失败:', err.message)
  }

  const conversationIds = [...affectedConversations.keys()]
  console.log(`[Messaging] 历史导入完成: ${imported} 条, 更新 ${updated} 条, 跳过 ${skipped} 条, ` +
    `涉及 ${conversationIds.length} 个会话, 归档 ${archivedCount} 个旧会话, 保留 ${preservedAiSelfCount} 个AI自助会话`)

  return {
    imported,
    updated,
    skipped,
    archived: archivedCount,
    pendingHuman: pendingHumanCount,
    preservedAiSelf: preservedAiSelfCount,
    conversationCount: conversationIds.length,
    conversationId: conversationIds[0] || null,
    conversations: conversationIds
  }
}

/**
 * 发送 AI 自动回复消息（AI 自助池场景）
 *
 * 当会话在 AI 自助池时，AI 生成的回复通过此方法发送给客户。
 * 会同时更新 last_reply_by = 'ai' 并写入消息表。
 *
 * @param {Object} message - { conversationId, content, messageType }
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<Object>}
 */
async function sendAiReply(message, eventEmitter) {
  try {
    // 1. 准备入库内容
    // AI 自助回复发给客户时必须保持客户原语言；坐席侧如果非中文则额外保存 translatedText 方便查看。
    let contentForStore = message.content || {}
    const aiReplyText = contentForStore.text || contentForStore.content || ''
    if ((message.messageType || 'text') === 'text' && aiReplyText && typeof aiReplyText === 'string') {
      try {
        const configService = require('../../services/configService')
        const translateModel = await configService.getConfig('llm_translate_model')
        const rawContextCount = await configService.getConfig('translation_context_message_count')
        const contextCount = Math.max(0, Math.min(parseInt(rawContextCount, 10) || 0, 10))
        const contextMessages = contextCount > 0
          ? await getConversationContext(message.conversationId, contextCount)
          : []
        const { processTranslation } = require('../../services/translationService')
        const result = await processTranslation(aiReplyText, translateModel, 'qwen3.6-flash', {
          contextMessages
        })
        if (result.translated) {
          contentForStore = {
            ...contentForStore,
            text: result.originalText || aiReplyText,
            translatedText: result.text,
            originalLang: result.originalLang || 'unknown',
            langLabel: result.langLabel || '未知语言',
            translated: true
          }
          console.log('[Messaging] AI回复已生成坐席侧中文译文:', result.langLabel, '上下文条数:', contextMessages.length)
        }
      } catch (transErr) {
        console.error('[Messaging] AI回复翻译失败，仍按原语言入库:', transErr.message)
      }
    }

    // 2. 存储消息（direction=outbound, sender_type=ai, send_status=sent）
    const messageId = message.id || crypto.randomUUID()
    await sequelize.query(
      `INSERT INTO plat_messages
        (id, conversation_id, channel, account_id, user_id, direction, sender_type, message_type, content, send_status, created_at, updated_at)
       SELECT :messageId, :conversationId, c.channel, c.account_id, c.user_id, 'outbound', 'ai',
              :messageType, :content, 'sent', NOW(), NOW()
       FROM conversations c WHERE c.id = :conversationId`,
      {
        replacements: {
          messageId,
          conversationId: message.conversationId,
          messageType: message.messageType || 'text',
          content: JSON.stringify(contentForStore)
        }
      }
    )
    systemLogger.info('message.ai_reply_stored', {
      messageId,
      conversationId: message.conversationId,
      messageType: message.messageType || 'text',
      senderType: 'ai'
    })

    // 3. 更新会话最后消息、时间、最后回复方为 AI
    let lastMessageText = ''
    try {
      const content = contentForStore || {}
      lastMessageText = content.translatedText || content.text || content.content || JSON.stringify(content)
    } catch {
      lastMessageText = String(contentForStore || '')
    }
    if (lastMessageText.length > 200) {
      lastMessageText = lastMessageText.substring(0, 200) + '...'
    }

    await sequelize.query(
      `UPDATE conversations
       SET last_message = :lastMessage, last_message_time = NOW(),
           last_reply_by = :replyBy, last_reply_time = NOW()
       WHERE id = :conversationId`,
      { replacements: { lastMessage: lastMessageText, replyBy: LAST_REPLY_BY.AI, conversationId: message.conversationId } }
    )

    // 4. 发射消息状态事件 + 新消息事件（让坐席实时看到 AI 回复）
    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.MESSAGE_UPDATE, {
        conversationId: message.conversationId,
        messageId,
        sendStatus: 'sent'
      })
      // 推送 AI 回复为新消息，坐席可在工作台实时看到（带 senderType='ai' 标识）
      eventEmitter.emit(INTERNAL_EVENTS.NEW_MESSAGE, {
        id: messageId,
        conversationId: message.conversationId,
        direction: 'outbound',
        senderType: 'ai',
        messageType: message.messageType || 'text',
        content: contentForStore,
        sendStatus: 'sent',
        serverTimestamp: Date.now()
      })
    }

    return { success: true, messageId }
  } catch (error) {
    console.error('[Messaging] AI回复失败:', error.message)
    throw error
  }
}

module.exports = {
  processIncomingMessage,
  sendOutboundMessage,
  sendAiReply,
  assignConversation,
  getConversationContext,
  findOrCreateConversation,
  importHistoryMessages
}
