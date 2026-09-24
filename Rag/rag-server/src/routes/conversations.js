/**
 * 聚合平台会话与消息 API
 *
 * 接口列表：
 * - GET    /api/v1/conversations                   查询会话列表（支持筛选，含 pool_type）
 * - GET    /api/v1/conversations/pool-stats        各池数量统计
 * - GET    /api/v1/conversations/assignable-seats  可分配坐席列表（supervisor/admin）
 * - GET    /api/v1/conversations/pool-logs         池操作日志（supervisor/admin）
 * - GET    /api/v1/conversations/pool-config       获取全部配置（admin）
 * - PUT    /api/v1/conversations/pool-config/:key  更新配置项（admin，实时生效）
 * - GET    /api/v1/conversations/queue-stats       AI回复队列监控（admin/supervisor）
 * - GET    /api/v1/conversations/ai-reply-logs     AI回复业务日志（admin/supervisor）
 * - GET    /api/v1/conversations/:id               查询单个会话详情
 * - PATCH  /api/v1/conversations/:id               更新会话
 * - GET    /api/v1/conversations/:id/messages      查询会话消息历史
 * - POST   /api/v1/conversations/:id/messages      发送消息
 * - POST   /api/v1/conversations/:id/assign        分配/转接会话给坐席（兼容旧接口）
 * - POST   /api/v1/conversations/:id/claim         抢单（坐席认领）
 * - POST   /api/v1/conversations/:id/release       释放会话回公共池
 * - POST   /api/v1/conversations/:id/mark-long-term 标记长期跟进
 * - POST   /api/v1/conversations/:id/archive       归档会话
 * - POST   /api/v1/conversations/:id/revive        复活归档会话
 * - POST   /api/v1/conversations/:id/transfer-to-ai 转入 AI 自助池
 * - POST   /api/v1/conversations/:id/transfer      转交会话（supervisor/admin）
 * - POST   /api/v1/conversations/:id/sync-history  拉取 WAHA 历史消息
 * - POST   /api/v1/conversations/sync-all-history  统一拉取历史
 * - POST   /api/v1/conversations/:id/fetch-avatar  获取/刷新联系人头像
 * - POST   /api/v1/conversations/batch-fetch-avatars  批量回填头像
 * - GET    /api/v1/conversations/nationalities     获取国籍字典
 * - POST   /api/v1/conversations/:id/infer-nationality 手动重新推测国籍
 *
 * 认证：需要 JWT Token（agent/supervisor/admin 权限）
 */

const express = require('express')
const { randomUUID } = require('crypto')
const router = express.Router()
const { sequelize } = require('../config/database')
const { createAuthenticate } = require('../middleware/authenticate')
const messagingService = require('../modules/messaging/messaging.service')
const poolService = require('../modules/conversation-pool/pool.service')
const { POOL_TYPE, CONV_STATUS, POOL_TAB_ORDER } = require('../modules/conversation-pool/constants')
const { getWahaClientByAccount } = require('../shared/utils/wahaClient')
const WahaAdapter = require('../modules/channel-adapters/whatsapp-waha/wahaAdapter')
const configService = require('../services/configService')
const { getQueueStats, aiReplyQueue, markLatestAiReplyJob, removePendingAiReplyJobs } = require('../queues')
const { redisClient } = require('../config/redis')
const { INTERNAL_EVENTS } = require('../modules/websocket/events')
const avatarService = require('../services/avatarService')
const nationalityService = require('../modules/nationality/nationality.service')
const { attachCustomerPhones } = require('../services/customerPhoneService')
const languageGuard = require('../services/languageGuard')
const translationService = require('../services/translationService')
const { normalizeConversationAccountId } = require('../modules/conversations/conversationListQuery')
const historyMediaAdapter = new WahaAdapter()

const syncAllHistoryJobs = new Map()
const MAX_SYNC_ALL_HISTORY_JOBS = 20
const SYNC_ALL_HISTORY_CHAT_CONCURRENCY = 2
const privilegedActionWindows = new Map()
let batchAvatarJobOwner = null

function boundedInteger(value, { fallback, min = 1, max }) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

async function acquireSharedLease(key, ttlSeconds = 3600) {
  const token = randomUUID()
  const acquired = await redisClient.set(key, token, 'EX', ttlSeconds, 'NX')
  return acquired === 'OK' ? { key, token } : null
}

async function releaseSharedLease(lease) {
  if (!lease) return
  await redisClient.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then
       return redis.call('del', KEYS[1])
     end
     return 0`,
    1,
    lease.key,
    lease.token
  )
}

function enforcePrivilegedActionRateLimit(req, res, action, { max = 2, windowMs = 60000 } = {}) {
  const userId = req.user.id || req.user.userId
  const key = `${userId}:${action}`
  const now = Date.now()
  const recent = (privilegedActionWindows.get(key) || []).filter(timestamp => now - timestamp < windowMs)
  if (recent.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000))
    res.set('Retry-After', String(retryAfter))
    res.status(429).json({ success: false, message: '操作过于频繁，请稍后再试' })
    return false
  }
  privilegedActionWindows.set(key, [...recent, now])
  return true
}

async function hasPrivilegedAccountScope(req, accountId) {
  if (req.user.role === 'admin') return true
  const parsedAccountId = Number(accountId)
  if (!Number.isInteger(parsedAccountId) || parsedAccountId <= 0) return false
  const [bindings] = await sequelize.query(
    `SELECT id FROM seat_account_bindings
     WHERE seat_id = :seatId AND account_id = :accountId AND status = 'active'
     LIMIT 1`,
    { replacements: { seatId: req.user.id || req.user.userId, accountId: parsedAccountId } }
  )
  return bindings.length > 0
}

async function requirePrivilegedAccountScope(req, res, accountId) {
  const allowed = await hasPrivilegedAccountScope(req, accountId)
  if (!allowed) {
    res.status(403).json({ success: false, message: '无权操作该渠道账号' })
    return false
  }
  return true
}

async function logPoolActionRequired(req, { action, reason }) {
  await sequelize.query(
    `INSERT INTO conversation_pool_logs
      (conversation_id, action, from_pool, to_pool, operator_id,
       operator_name, operator_type, reason, created_at)
     VALUES ('global', :action, NULL, NULL, :operatorId,
             :operatorName, :operatorType, :reason, NOW())`,
    {
      replacements: {
        action,
        operatorId: req.user.id || req.user.userId,
        operatorName: req.user.username || '',
        operatorType: req.user.role,
        reason
      }
    }
  )
}

function summarizeHttpError(err) {
  const parts = [err.message]
  if (err.response?.status) {
    parts.push(`status=${err.response.status}`)
  }
  if (err.response?.data) {
    const data = typeof err.response.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response.data)
    parts.push(`response=${data.slice(0, 500)}`)
  }
  return parts.filter(Boolean).join(' | ')
}

function isTimeoutLikeError(err) {
  const text = typeof err === 'string'
    ? err
    : [err?.message, err?.code, err?.name].filter(Boolean).join(' ')
  return /timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(text)
}

function createSyncAllHistoryJob(user) {
  const job = {
    id: `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    message: '等待开始',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    createdBy: user?.id || user?.userId || null,
    progress: {
      totalAccounts: 0,
      accountsProcessed: 0,
      totalChats: 0,
      chatsProcessed: 0,
      currentAccountId: null,
      currentChatId: null,
      totalMessagesFetched: 0,
      totalMessagesConverted: 0,
      totalEarlySkipped: 0,
      totalImported: 0,
      totalUpdated: 0,
      totalSkipped: 0
    },
    accountResults: [],
    errors: [],
    result: null
  }
  syncAllHistoryJobs.set(job.id, job)
  pruneSyncAllHistoryJobs()
  return job
}

function pruneSyncAllHistoryJobs() {
  const jobs = Array.from(syncAllHistoryJobs.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  for (const job of jobs.slice(MAX_SYNC_ALL_HISTORY_JOBS)) {
    if (job.status !== 'running' && job.status !== 'pending') {
      syncAllHistoryJobs.delete(job.id)
    }
  }
}

function getRunningSyncAllHistoryJob() {
  return Array.from(syncAllHistoryJobs.values()).find(job => job.status === 'pending' || job.status === 'running')
}

function serializeSyncAllHistoryJob(job) {
  if (!job) return null
  const progress = job.progress || {}
  const percent = job.status === 'completed'
    ? 100
    : progress.totalChats > 0
      ? Math.min(99, Math.floor((progress.chatsProcessed / progress.totalChats) * 100))
      : job.status === 'running'
        ? 1
        : 0

  return {
    id: job.id,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    percent,
    progress,
    accountResults: job.accountResults,
    errors: job.errors.slice(-10),
    result: job.result
  }
}

function setSyncJobMessage(job, message) {
  job.message = message
  job.updatedAt = new Date().toISOString()
}

async function runSyncAllHistoryJob(job, { body, eventEmitter }) {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  setSyncJobMessage(job, '正在准备同步任务')

  const { account_id, accountId, limit, forceUpdate } = body || {}
  const requestedAccountId = account_id ?? accountId
  const parsedAccountId = requestedAccountId ? Number(requestedAccountId) : null
  const historyLimit = boundedInteger(limit, { fallback: 100, max: 500 })

  let targetAccounts = []
  if (requestedAccountId) {
    if (!Number.isInteger(parsedAccountId) || parsedAccountId <= 0) {
      throw new Error('账号ID无效')
    }
    targetAccounts = [{ id: parsedAccountId }]
  } else {
    const [accounts] = await sequelize.query(
      `SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND status = 'active' ORDER BY id ASC`,
      { replacements: {} }
    )
    targetAccounts = accounts
  }

  // 没有后台绑定账号时，兼容旧部署：降级同步实例池默认账号
  if (targetAccounts.length === 0) {
    targetAccounts = [{ id: null }]
  }

  job.progress.totalAccounts = targetAccounts.length

  let accountsSynced = 0
  let totalImported = 0
  let totalSkipped = 0
  let totalUpdated = 0
  let chatsProcessed = 0
  let totalMessagesFetched = 0
  let totalMessagesConverted = 0
  const accountResults = []
  const errors = []

  for (const account of targetAccounts) {
    const currentAccountId = account.id || null
    let waha = null
    job.progress.currentAccountId = currentAccountId
    setSyncJobMessage(job, `正在同步账号 ${currentAccountId || '默认实例'}`)

    try {
      waha = await getWahaClientByAccount(currentAccountId)
      if (!waha) {
        const message = currentAccountId
          ? `账号 ${currentAccountId} 无可用 WAHA 实例`
          : '无可用 WAHA 实例，请先配置 WhatsApp 账号'
        errors.push({ accountId: currentAccountId, error: message })
        job.errors = errors
        continue
      }

      console.log(`[SyncAllHistory] 获取聊天列表, accountId=${waha.accountId || 'fallback'}, session=${waha.sessionName}, baseURL=${waha.client.defaults.baseURL}`)

      const chatsResponse = await waha.client.get(`/api/${waha.sessionName}/chats`, {
        params: { sortBy: 'conversationTimestamp', sortOrder: 'desc', limit: 200 }
      })

      const chats = chatsResponse.data || []
      const syncableChats = chats.filter(chat => {
        const chatId = getWahaChatId(chat)
        return chatId && !isSkippableWahaChat(chatId)
      })
      job.progress.totalChats += syncableChats.length
      console.log(`[SyncAllHistory] accountId=${waha.accountId || 'fallback'} WAHA 返回 ${chats.length} 个聊天，可同步 ${syncableChats.length} 个`)

      let accountImported = 0
      let accountSkipped = 0
      let accountUpdated = 0
      let accountChatsProcessed = 0
      let accountMessagesFetched = 0
      let accountMessagesConverted = 0
      let accountEmptyMessageChats = 0
      let accountUnconvertedMessageChats = 0
      let accountLidFallbackChats = 0
      let accountEarlySkipped = 0

      let nextChatIndex = 0
      const processChat = async (chat) => {
        const chatId = getWahaChatId(chat)
        job.progress.currentChatId = chatId
        setSyncJobMessage(job, `正在同步账号 ${waha.accountId || '默认实例'} 的联系人 ${chatId}`)
        let currentStage = '准备同步'

        try {
          currentStage = '拉 messages'
          const fetchResult = await fetchWahaChatMessages(waha, chatId, historyLimit, chat)
          if (fetchResult.usedLidFallback) {
            accountLidFallbackChats++
          }
          const wahaMessages = fetchResult.messages
          accountMessagesFetched += wahaMessages.length
          totalMessagesFetched += wahaMessages.length
          job.progress.totalMessagesFetched = totalMessagesFetched
          if (wahaMessages.length === 0) {
            accountEmptyMessageChats++
            console.warn(`[SyncAllHistory] accountId=${waha.accountId || 'fallback'} ${chatId}: messages endpoint returned 0`, summarizeWahaChat(chat))
            accountChatsProcessed++
            chatsProcessed++
            job.progress.chatsProcessed = chatsProcessed
            return
          }

          currentStage = '转换消息'
          const standardMessages = wahaMessages
            .map(msg => wahaHistoryMessageToStandard(msg, chatId, waha.accountId))
            .filter(Boolean)
            .sort((a, b) => a.clientTimestamp - b.clientTimestamp)
          accountMessagesConverted += standardMessages.length
          totalMessagesConverted += standardMessages.length
          job.progress.totalMessagesConverted = totalMessagesConverted

          if (standardMessages.length === 0) {
            accountUnconvertedMessageChats++
            console.warn(`[SyncAllHistory] accountId=${waha.accountId || 'fallback'} ${chatId}: WAHA returned ${wahaMessages.length} messages but none were convertible`, summarizeWahaHistoryMessage(wahaMessages[0]))
          }

          currentStage = '过滤已存在消息'
          const { messagesToImport, earlySkipped } = await filterExistingHistoryMessagesBeforeHydrate(standardMessages, { forceUpdate: !!forceUpdate })
          accountEarlySkipped += earlySkipped
          accountSkipped += earlySkipped
          totalSkipped += earlySkipped
          job.progress.totalEarlySkipped += earlySkipped
          job.progress.totalSkipped = totalSkipped
          currentStage = '媒体下载'
          await hydrateHistoryMediaMessages(messagesToImport, waha.accountId)

          const chatName = chat.name || chat.formattedName || chatId.replace(/@.*$/, '')
          for (const msg of messagesToImport) {
            msg.userName = chatName
          }

          currentStage = '导入消息'
          const result = messagesToImport.length > 0
            ? await messagingService.importHistoryMessages(messagesToImport, eventEmitter, { forceUpdate: !!forceUpdate })
            : { imported: 0, skipped: 0, updated: 0 }

          accountImported += result.imported
          accountSkipped += result.skipped
          accountUpdated += (result.updated || 0)
          totalImported += result.imported
          totalSkipped += result.skipped
          totalUpdated += (result.updated || 0)
          accountChatsProcessed++
          chatsProcessed++
          job.progress.chatsProcessed = chatsProcessed
          job.progress.totalImported = totalImported
          job.progress.totalUpdated = totalUpdated
          job.progress.totalSkipped = totalSkipped

          if (result.imported > 0) {
            console.log(`[SyncAllHistory] accountId=${waha.accountId || 'fallback'} ${chatId} (${chatName}): ${result.imported} 导入, ${result.skipped + earlySkipped} 跳过${earlySkipped > 0 ? `, earlySkipped=${earlySkipped}` : ''}${fetchResult.usedLidFallback ? `, fetchChatId=${fetchResult.fetchChatId}` : ''}`)
          }
        } catch (chatErr) {
          const errorMessage = summarizeHttpError(chatErr)
          const stageResult = isTimeoutLikeError(chatErr) ? `${currentStage} 超时` : `${currentStage} 失败`
          console.error(`[SyncAllHistory] 处理账号 ${waha.accountId || 'fallback'} 聊天 ${chatId} ${stageResult}:`, errorMessage)
          errors.push({ accountId: waha.accountId, chatId, stage: currentStage, error: errorMessage })
          job.errors = errors
          accountChatsProcessed++
          chatsProcessed++
          job.progress.chatsProcessed = chatsProcessed
        }
      }

      const workerCount = Math.min(SYNC_ALL_HISTORY_CHAT_CONCURRENCY, syncableChats.length)
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextChatIndex < syncableChats.length) {
          const chat = syncableChats[nextChatIndex++]
          await processChat(chat)
        }
      }))

      accountsSynced++
      job.progress.accountsProcessed = accountsSynced

      accountResults.push({
        accountId: waha.accountId,
        sessionName: waha.sessionName,
        chatsProcessed: accountChatsProcessed,
        messagesFetched: accountMessagesFetched,
        messagesConverted: accountMessagesConverted,
        earlySkipped: accountEarlySkipped,
        emptyMessageChats: accountEmptyMessageChats,
        unconvertedMessageChats: accountUnconvertedMessageChats,
        lidFallbackChats: accountLidFallbackChats,
        totalImported: accountImported,
        totalUpdated: accountUpdated,
        totalSkipped: accountSkipped
      })
      job.accountResults = accountResults
    } catch (accountErr) {
      const errorMessage = summarizeHttpError(accountErr)
      console.error(`[SyncAllHistory] 同步账号 ${currentAccountId || 'fallback'} 失败:`, errorMessage)
      errors.push({ accountId: currentAccountId, error: errorMessage })
      job.errors = errors
      job.progress.accountsProcessed++
    }
  }

  if (accountsSynced === 0) {
    throw new Error(errors[0]?.error || '无可用 WAHA 实例，请先配置 WhatsApp 账号')
  }

  const result = {
    accountsSynced,
    chatsProcessed,
    totalMessagesFetched,
    totalMessagesConverted,
    totalEarlySkipped: job.progress.totalEarlySkipped,
    totalImported,
    totalUpdated,
    totalSkipped,
    accountResults,
    errors: errors.length > 0 ? errors.slice(0, 10) : []
  }

  console.log(`[SyncAllHistory] 完成: ${accountsSynced} 账号, ${chatsProcessed} 聊天, ${totalImported} 导入, ${totalUpdated} 更新, ${totalSkipped} 跳过`)
  console.log(`[SyncAllHistory] summary: accounts=${accountsSynced}, chats=${chatsProcessed}, messagesFetched=${totalMessagesFetched}, messagesConverted=${totalMessagesConverted}, earlySkipped=${job.progress.totalEarlySkipped}, imported=${totalImported}, updated=${totalUpdated}, skipped=${totalSkipped}`)

  // 异步批量获取头像（不阻塞同步任务完成状态）
  avatarService.batchFetchAvatars(50).then(avatarResult => {
    console.log(`[SyncAllHistory] 头像批量获取: ${avatarResult.success} 成功, ${avatarResult.skipped} 无头像, ${avatarResult.failed} 失败`)
  }).catch(e => {
    console.warn(`[SyncAllHistory] 头像批量获取失败:`, e.message)
  })

  job.status = 'completed'
  job.finishedAt = new Date().toISOString()
  job.progress.currentAccountId = null
  job.progress.currentChatId = null
  job.result = result
  setSyncJobMessage(job, `同步完成: 同步 ${accountsSynced} 个账号, 处理 ${chatsProcessed} 个联系人, 导入 ${totalImported} 条消息${totalUpdated > 0 ? `, 更新 ${totalUpdated} 条` : ''}${totalSkipped > 0 ? `, 跳过 ${totalSkipped} 条重复` : ''}，头像正在后台获取`)
}

// ========== 认证中间件 ==========
router.use(createAuthenticate())
router.use((req, res, next) => {
  req.eventEmitter = req.app.get('eventEmitter')
  next()
})

// ========== 公共函数：将 WAHA 消息转为 StandardMessage ==========
function firstWahaValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function normalizeWahaText(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function normalizeWahaMessageId(rawId) {
  if (!rawId) return null
  if (typeof rawId === 'string') return rawId
  if (typeof rawId === 'number') return String(rawId)
  if (typeof rawId === 'object') {
    return rawId._serialized || rawId.id || rawId.messageId || rawId.key?.id || JSON.stringify(rawId)
  }
  return String(rawId)
}

function normalizeWahaTimestamp(...values) {
  const raw = firstWahaValue(...values)
  if (!raw) return Date.now()

  const numeric = Number(raw)
  if (Number.isFinite(numeric)) {
    return numeric < 1000000000000 ? numeric * 1000 : numeric
  }

  const parsed = new Date(raw).getTime()
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function isTrueWahaFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function getWahaBaileysMessage(wahaMsg = {}) {
  return wahaMsg.message || wahaMsg._data?.message || wahaMsg.raw?.message || {}
}

function extractWahaContextInfo(wahaMsg = {}) {
  const message = getWahaBaileysMessage(wahaMsg)
  return message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.audioMessage?.contextInfo ||
    message.stickerMessage?.contextInfo ||
    null
}

function extractWahaQuotedText(quotedMessage = {}) {
  return extractWahaHistoryText({ message: quotedMessage }) ||
    quotedMessage.audioMessage?.mimetype ||
    quotedMessage.stickerMessage?.mimetype ||
    ''
}

function detectWahaHistoryMessageType(wahaMsg = {}) {
  const message = getWahaBaileysMessage(wahaMsg)
  const rawType = String(firstWahaValue(
    wahaMsg.type,
    wahaMsg.messageType,
    wahaMsg._data?.type,
    wahaMsg._data?.messageType
  ) || '').toLowerCase()

  if (message.imageMessage || rawType === 'image' || rawType === 'sticker') return 'image'
  if (message.videoMessage || rawType === 'video') return 'video'
  if (message.audioMessage || ['audio', 'ptt', 'voice'].includes(rawType)) return 'audio'
  if (message.documentMessage || ['document', 'file'].includes(rawType)) return 'file'
  return 'text'
}

function extractWahaHistoryText(wahaMsg = {}) {
  const message = getWahaBaileysMessage(wahaMsg)
  return normalizeWahaText(firstWahaValue(
    wahaMsg.body,
    wahaMsg.text,
    wahaMsg.caption,
    wahaMsg._data?.body,
    wahaMsg._data?.text,
    wahaMsg._data?.caption,
    message.conversation,
    message.extendedTextMessage?.text,
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption
  ))
}

function extractWahaNestedMedia(wahaMsg = {}) {
  const message = getWahaBaileysMessage(wahaMsg)
  const candidates = [
    wahaMsg.media,
    wahaMsg.file,
    wahaMsg.image,
    wahaMsg.video,
    wahaMsg.audio,
    wahaMsg.document,
    wahaMsg.attachment,
    wahaMsg._data?.media,
    wahaMsg._data?.file,
    message.imageMessage,
    message.videoMessage,
    message.audioMessage,
    message.documentMessage,
    message.stickerMessage
  ]
  return candidates.find(item => item && typeof item === 'object') || {}
}

function extractWahaHistoryMediaMeta(wahaMsg = {}) {
  const nested = extractWahaNestedMedia(wahaMsg)
  const rawType = firstWahaValue(
    wahaMsg.type,
    wahaMsg.messageType,
    wahaMsg._data?.type,
    wahaMsg._data?.messageType
  )
  const mimeType = firstWahaValue(
    wahaMsg.mimetype,
    wahaMsg.mimeType,
    wahaMsg.mime,
    wahaMsg._data?.mimetype,
    wahaMsg._data?.mimeType,
    wahaMsg._data?.mime,
    nested.mimetype,
    nested.mimeType,
    nested.mime
  )
  const mediaUrl = firstWahaValue(
    wahaMsg.mediaUrl,
    wahaMsg.downloadUrl,
    wahaMsg.fileUrl,
    wahaMsg.url,
    wahaMsg._data?.mediaUrl,
    wahaMsg._data?.downloadUrl,
    wahaMsg._data?.fileUrl,
    wahaMsg._data?.url,
    nested.mediaUrl,
    nested.downloadUrl,
    nested.fileUrl,
    nested.url
  )
  const mediaData = firstWahaValue(
    wahaMsg.mediaData,
    wahaMsg.data,
    wahaMsg.base64,
    wahaMsg._data?.mediaData,
    wahaMsg._data?.data,
    wahaMsg._data?.base64,
    nested.data,
    nested.base64
  )
  const fileName = firstWahaValue(
    wahaMsg.fileName,
    wahaMsg.filename,
    wahaMsg._data?.fileName,
    wahaMsg._data?.filename,
    nested.fileName,
    nested.filename,
    nested.file_name,
    `${rawType || 'media'}-${Date.now()}`
  )

  if (!wahaMsg.hasMedia && !wahaMsg._data?.hasMedia && !mediaUrl && !mediaData && !mimeType) {
    return null
  }

  return { rawType, mimeType, mediaUrl, mediaData, fileName }
}

function summarizeWahaHistoryMessage(wahaMsg = {}) {
  const message = getWahaBaileysMessage(wahaMsg)
  return {
    keys: Object.keys(wahaMsg).slice(0, 12),
    type: wahaMsg.type || wahaMsg.messageType || wahaMsg._data?.type || null,
    messageKeys: message && typeof message === 'object' ? Object.keys(message).slice(0, 8) : [],
    hasBody: Boolean(wahaMsg.body || wahaMsg._data?.body),
    hasText: Boolean(wahaMsg.text || wahaMsg._data?.text),
    hasCaption: Boolean(wahaMsg.caption || wahaMsg._data?.caption),
    hasMedia: Boolean(wahaMsg.hasMedia || wahaMsg._data?.hasMedia)
  }
}

function normalizeWahaChatId(rawId) {
  if (!rawId) return null
  if (typeof rawId === 'string') return rawId
  if (typeof rawId === 'object') {
    if (rawId._serialized) return rawId._serialized
    if (typeof rawId.id === 'string' && rawId.server) return `${rawId.id}@${rawId.server}`
    if (typeof rawId.user === 'string' && rawId.server) return `${rawId.user}@${rawId.server}`
    if (typeof rawId.id === 'string') return rawId.id
  }
  return null
}

function getWahaChatId(chat = {}) {
  return normalizeWahaChatId(chat.id) ||
    normalizeWahaChatId(chat.chatId) ||
    normalizeWahaChatId(chat._serialized) ||
    normalizeWahaChatId(chat._data?.id)
}

function summarizeWahaChat(chat = {}) {
  return {
    keys: Object.keys(chat).slice(0, 12),
    id: getWahaChatId(chat),
    name: chat.name || chat.formattedName || chat.pushname || null,
    unreadCount: chat.unreadCount ?? chat.unread_count ?? null,
    timestamp: chat.timestamp || chat.conversationTimestamp || chat.lastMessage?.timestamp || null,
    lastMessageKeys: chat.lastMessage && typeof chat.lastMessage === 'object'
      ? Object.keys(chat.lastMessage).slice(0, 8)
      : []
  }
}

function phoneChatIdFromDisplayName(value) {
  if (!value || typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '')
  return digits.length >= 6 ? `${digits}@c.us` : null
}

function getWahaChatPhoneFallbackId(chat = {}) {
  return phoneChatIdFromDisplayName(chat.name) ||
    phoneChatIdFromDisplayName(chat.formattedName) ||
    phoneChatIdFromDisplayName(chat.pushname)
}

function isSkippableWahaChat(chatId) {
  return chatId.includes('@g.us') ||
    chatId === 'status@broadcast' ||
    chatId.includes('@broadcast') ||
    chatId.includes('@newsletter')
}

async function fetchWahaChatMessages(waha, chatId, historyLimit, chat = null) {
  const params = { limit: historyLimit, sortOrder: 'DESC', downloadMedia: true }
  const encodedChatId = encodeURIComponent(chatId)
  const response = await waha.client.get(`/api/${waha.sessionName}/chats/${encodedChatId}/messages`, { params })
  const messages = Array.isArray(response.data) ? response.data : []

  if (messages.length > 0 || !chatId.includes('@lid')) {
    return { messages, fetchChatId: chatId, resolvedChatId: null, usedLidFallback: false }
  }

  const fallbackChatIds = []

  try {
    const lidResponse = await waha.client.get(`/api/${waha.sessionName}/lids/${encodedChatId}`, { timeout: 5000 })
    const resolvedChatId = lidResponse.data?.pn || lidResponse.data?.chatId || lidResponse.data?.id || null
    if (resolvedChatId && resolvedChatId !== chatId && String(resolvedChatId).includes('@c.us')) {
      fallbackChatIds.push(String(resolvedChatId))
    } else if (resolvedChatId) {
      console.warn(`[SyncAllHistory] LID ${chatId} resolved to non-phone chatId: ${resolvedChatId}`)
    }
  } catch (err) {
    console.warn(`[SyncAllHistory] LID messages fallback failed for ${chatId}:`, summarizeHttpError(err))
  }

  const displayPhoneChatId = chat ? getWahaChatPhoneFallbackId(chat) : null
  if (displayPhoneChatId && displayPhoneChatId !== chatId) {
    fallbackChatIds.push(displayPhoneChatId)
  }

  for (const fallbackChatId of [...new Set(fallbackChatIds)]) {
    try {
      const retryResponse = await waha.client.get(`/api/${waha.sessionName}/chats/${encodeURIComponent(fallbackChatId)}/messages`, { params })
      const retryMessages = Array.isArray(retryResponse.data) ? retryResponse.data : []
      console.warn(`[SyncAllHistory] LID messages fallback ${chatId} -> ${fallbackChatId}: ${retryMessages.length} messages`)
      if (retryMessages.length > 0) {
        return { messages: retryMessages, fetchChatId: fallbackChatId, resolvedChatId: fallbackChatId, usedLidFallback: true }
      }
    } catch (err) {
      console.warn(`[SyncAllHistory] LID messages retry failed ${chatId} -> ${fallbackChatId}:`, summarizeHttpError(err))
    }
  }

  return { messages, fetchChatId: chatId, resolvedChatId: null, usedLidFallback: false }
}

function wahaMessageToStandard(wahaMsg, chatId, accountId) {
  let text = ''
  if (wahaMsg.body) {
    text = wahaMsg.body
  } else if (wahaMsg.message?.conversation) {
    text = wahaMsg.message.conversation
  } else if (wahaMsg.message?.extendedTextMessage?.text) {
    text = wahaMsg.message.extendedTextMessage.text
  } else {
    return null // 跳过非文本消息
  }

  const direction = wahaMsg.fromMe ? 'outbound' : 'inbound'

  // 消息 ID：WAHA 可能返回字符串或对象
  const channelMessageId = typeof wahaMsg.id === 'string'
    ? wahaMsg.id
    : (wahaMsg.id?._serialized || wahaMsg.id?.id || wahaMsg.key?.id || null)
  const timestamp = wahaMsg.timestamp
    ? parseInt(wahaMsg.timestamp) * 1000
    : (wahaMsg.messageTimestamp ? parseInt(wahaMsg.messageTimestamp) * 1000 : Date.now())

  // 处理引用回复：WAHA 字段名为 replyTo（非 quotedMsg），包含 { id, body, participant, _data }
  // ReplyToMessage 没有 from 字段，尝试从 _data 中提取发送者
  let quotedContext = null
  if (wahaMsg.replyTo) {
    console.log('[SyncHistory] 检测到引用回复, replyTo keys:', Object.keys(wahaMsg.replyTo), 'body:', wahaMsg.replyTo.body?.substring(0, 100), '_data keys:', wahaMsg.replyTo._data ? Object.keys(wahaMsg.replyTo._data) : 'none')
    const quotedBody = wahaMsg.replyTo.body || ''
    if (quotedBody) {
      const from = wahaMsg.replyTo._data?.from || wahaMsg.replyTo._data?.author
        || wahaMsg.replyTo.participant || null
      quotedContext = {
        text: quotedBody,
        from
      }
      // body 中如果包含引用原文，去重
      if (text.startsWith(quotedBody)) {
        text = text.substring(quotedBody.length).trim()
        text = text.replace(/^[\n\r\s>…\-—]+/, '').trim()
      }
    }
  }

  return {
    channel: 'whatsapp',
    accountId: accountId || null,
    channelUserId: chatId,
    direction,
    messageType: 'text',
    content: {
      text,
      ...(quotedContext ? { quotedMsg: quotedContext } : {})
    },
    channelMessageId,
    clientTimestamp: timestamp,
    serverTimestamp: timestamp
  }
}

function wahaHistoryMessageToStandard(wahaMsg, chatId, accountId) {
  let text = extractWahaHistoryText(wahaMsg)
  const messageType = detectWahaHistoryMessageType(wahaMsg)
  const mediaMeta = messageType !== 'text' ? extractWahaHistoryMediaMeta(wahaMsg) : null
  if (!text && messageType === 'text') {
    return null
  }

  const direction = [
    wahaMsg.fromMe,
    wahaMsg.id?.fromMe,
    wahaMsg.key?.fromMe,
    wahaMsg._data?.fromMe,
    wahaMsg._data?.id?.fromMe,
    wahaMsg._data?.key?.fromMe
  ].some(isTrueWahaFlag) ? 'outbound' : 'inbound'

  const channelMessageId = normalizeWahaMessageId(
    wahaMsg.id || wahaMsg.key || wahaMsg._data?.id || wahaMsg._data?.key
  )
  const timestamp = normalizeWahaTimestamp(
    wahaMsg.timestamp,
    wahaMsg.messageTimestamp,
    wahaMsg.t,
    wahaMsg._data?.timestamp,
    wahaMsg._data?.t,
    wahaMsg._data?.messageTimestamp
  )

  let quotedContext = null
  const replyTo = wahaMsg.replyTo || wahaMsg._data?.replyTo || null
  if (replyTo) {
    const quotedBody = replyTo.body || replyTo.text || ''
    if (quotedBody) {
      const from = replyTo._data?.from || replyTo._data?.author || replyTo.participant || null
      quotedContext = { text: quotedBody, from }
      if (text.startsWith(quotedBody)) {
        text = text.substring(quotedBody.length).trim()
        text = text.replace(/^[\n\r\s>\-:]+/, '').trim()
      }
    }
  }
  const contextInfo = extractWahaContextInfo(wahaMsg)
  if (!quotedContext && contextInfo?.quotedMessage) {
    const quotedText = extractWahaQuotedText(contextInfo.quotedMessage)
    if (quotedText) {
      quotedContext = {
        text: quotedText,
        from: contextInfo.participant || null,
        id: contextInfo.stanzaId || null
      }
    }
  }

  return {
    channel: 'whatsapp',
    accountId: accountId || null,
    channelUserId: chatId,
    direction,
    messageType,
    content: {
      text,
      ...(messageType !== 'text' ? {
        hasMedia: true,
        rawType: mediaMeta?.rawType || wahaMsg.type || wahaMsg.messageType || wahaMsg._data?.type || null,
        mimeType: mediaMeta?.mimeType || null,
        fileName: mediaMeta?.fileName || null,
        remoteUrl: mediaMeta?.mediaUrl || null,
        fileUrl: mediaMeta?.mediaUrl || null,
        mediaData: mediaMeta?.mediaData || null,
        transcriptionStatus: messageType === 'audio' ? 'not_started' : undefined
      } : {}),
      ...(quotedContext ? { quotedMsg: quotedContext } : {})
    },
    channelMessageId,
    clientTimestamp: timestamp,
    serverTimestamp: timestamp
  }
}

async function hydrateHistoryMediaMessages(messages = [], accountId) {
  for (const msg of messages) {
    if (msg?.content?.hasMedia) {
      await historyMediaAdapter.downloadIncomingMedia(msg, accountId || msg.accountId)
      if (msg?.content?.downloadStatus === 'failed') {
        const downloadError = msg.content.downloadError || 'unknown media download error'
        const stageResult = isTimeoutLikeError(downloadError) ? '媒体下载超时' : '媒体下载失败'
        console.warn(
          `[SyncAllHistory] ${stageResult}: accountId=${accountId || msg.accountId || 'fallback'} ` +
          `chat=${msg.channelUserId || '-'} message=${msg.channelMessageId || '-'}: ${downloadError}`
        )
      }
    }
  }
  return messages
}

function parseHistoryMessageContent(content) {
  try {
    return typeof content === 'string' ? JSON.parse(content) : (content || {})
  } catch {
    return typeof content === 'string' ? { text: content } : {}
  }
}

function canEarlySkipExistingHistoryMessage(existingContent, nextContent = {}, forceUpdate = false) {
  if (forceUpdate) return false
  if (!nextContent?.hasMedia) return true

  const existing = parseHistoryMessageContent(existingContent)
  const existingUrl = existing.fileUrl || existing.url
  return Boolean(existingUrl && existing.downloadStatus !== 'failed')
}

async function filterExistingHistoryMessagesBeforeHydrate(messages = [], { forceUpdate = false } = {}) {
  const ids = [...new Set(messages.map(msg => msg.channelMessageId).filter(Boolean))]
  if (ids.length === 0) {
    return { messagesToImport: messages, earlySkipped: 0 }
  }

  const [existingRows] = await sequelize.query(
    `SELECT channel_message_id, content
     FROM plat_messages
     WHERE channel_message_id IN (:ids)`,
    { replacements: { ids } }
  )
  const existingById = new Map(existingRows.map(row => [row.channel_message_id, row]))

  let earlySkipped = 0
  const messagesToImport = []
  for (const msg of messages) {
    const existing = msg.channelMessageId ? existingById.get(msg.channelMessageId) : null
    if (existing && canEarlySkipExistingHistoryMessage(existing.content, msg.content || {}, forceUpdate)) {
      earlySkipped++
      continue
    }
    messagesToImport.push(msg)
  }

  return { messagesToImport, earlySkipped }
}

function getCurrentUserId(req) {
  return req.user.id || req.user.userId
}

function isSelfRecipientSendResult(sendResult) {
  return sendResult?.reason === 'self_recipient' ||
    /resolves to the sending account phone|same as the sending account phone/i.test(sendResult?.error || '')
}

async function findAlternateBoundWhatsappAccount(seatId, currentAccountId) {
  const [rows] = await sequelize.query(
    `SELECT ca.id, ca.account_name, ca.phone_number, ca.whatsapp_name
     FROM seat_account_bindings sab
     INNER JOIN channel_accounts ca ON ca.id = sab.account_id
     WHERE sab.seat_id = :seatId
       AND sab.status = 'active'
       AND sab.channel = 'whatsapp'
       AND ca.channel = 'whatsapp'
       AND ca.adapter_type = 'waha'
       AND ca.status = 'active'
       AND ca.id != :currentAccountId
     ORDER BY ca.id ASC
     LIMIT 1`,
    { replacements: { seatId, currentAccountId: currentAccountId || 0 } }
  )
  return rows[0] || null
}

function addAgentVisibilityCondition(req, conditions, replacements, alias = 'c') {
  if (req.user.role !== 'agent') return
  conditions.push(`(
    ${alias}.account_id IN (
      SELECT account_id FROM seat_account_bindings
      WHERE seat_id = :visibilityUserId AND status = 'active'
    )
    AND (${alias}.claimed_by = :visibilityUserId OR ${alias}.agent_id = :visibilityUserId)
  )`)
  replacements.visibilityUserId = getCurrentUserId(req)
}

async function checkConversationAccess(req, conversationId) {
  if (req.user.role !== 'agent') {
    const [rows] = await sequelize.query(
      `SELECT id FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )
    return { exists: rows.length > 0, visible: rows.length > 0 }
  }

  const conditions = ['c.id = :conversationId']
  const replacements = { conversationId }
  addAgentVisibilityCondition(req, conditions, replacements)
  const [visibleRows] = await sequelize.query(
    `SELECT c.id FROM conversations c WHERE ${conditions.join(' AND ')} LIMIT 1`,
    { replacements }
  )
  if (visibleRows.length > 0) return { exists: true, visible: true }

  const [existsRows] = await sequelize.query(
    `SELECT id FROM conversations WHERE id = :conversationId LIMIT 1`,
    { replacements: { conversationId } }
  )
  return { exists: existsRows.length > 0, visible: false }
}

async function requireConversationAccess(req, res, conversationId) {
  const access = await checkConversationAccess(req, conversationId)
  if (!access.exists || !access.visible) {
    res.status(404).json({ success: false, message: '会话不存在或无权访问' })
    return false
  }
  return true
}

function parseContextJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

// Returns the customer workspace context for a conversation deep-link. Access is
// checked against the conversation first so agents cannot infer customers by phone.
router.get('/:id/customer-context', async (req, res) => {
  try {
    const { id } = req.params
    if (!await requireConversationAccess(req, res, id)) return

    const [sourceRows] = await sequelize.query(
      `SELECT cv.id, cv.channel, cv.account_id, cv.user_id, cv.user_name,
              cv.claimed_by, cv.agent_id, cv.pool_type, cv.conv_status,
              cv.last_message, DATE_FORMAT(cv.last_message_time, '%Y-%m-%d %H:%i:%s') AS lastMessageTime
       FROM conversations cv WHERE cv.id = :conversationId LIMIT 1`,
      { replacements: { conversationId: id } }
    )
    if (!sourceRows.length) return res.status(404).json({ success: false, message: '会话不存在或无权访问' })
    const sourceConversation = sourceRows[0]

    const [customerRows] = await sequelize.query(
      `SELECT c.id, c.phone, c.display_name, c.owner_id, c.won_status,
              DATE_FORMAT(c.won_at, '%Y-%m-%d %H:%i:%s') AS wonAt,
              c.ai_profile, DATE_FORMAT(c.updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAt
       FROM customer_identities ci
       JOIN customers c ON c.id = ci.customer_id
       WHERE ci.channel = :channel
         AND ci.account_id <=> :accountId
         AND ci.external_user_id = :externalUserId
       LIMIT 1`,
      { replacements: { channel: sourceConversation.channel, accountId: sourceConversation.account_id, externalUserId: sourceConversation.user_id } }
    )
    if (!customerRows.length) {
      return res.json({
        success: true,
        data: {
          customer: null,
          activeConversation: sourceConversation,
          sourceConversation,
          communicationStage: null,
          aiProfile: null,
          followups: [],
          orders: [],
          identities: [],
          permissions: { canOpenConversation: true, canMarkWon: false, canEditProfile: false },
          generatedAt: new Date().toISOString()
        }
      })
    }
    const customer = customerRows[0]
    const customerId = customer.id
    const agent = req.user.role === 'agent'
    const viewerId = req.user.id || req.user.userId
    const resolvedLanguage = await languageGuard.resolveCustomerLanguage(id)
    const languageProfile = {
      code: resolvedLanguage.code || 'zh',
      label: resolvedLanguage.label || resolvedLanguage.code || 'zh',
      group: resolvedLanguage.group || (resolvedLanguage.code === 'zh' ? 'zh' : 'other'),
      confidence: resolvedLanguage.code && resolvedLanguage.code !== 'unknown' ? 0.9 : 0.2,
      politeness: ['ja', 'ko'].includes(resolvedLanguage.code) ? 'honorific' : 'neutral',
      source: 'latest_customer_message'
    }
    const ownerFilter = agent ? 'AND (f.assigned_to = :viewerId OR c.owner_id = :viewerId)' : ''
    const conversationFilter = agent ? 'AND (cv.claimed_by = :viewerId OR cv.agent_id = :viewerId)' : ''
    const replacementBase = { customerId, viewerId }

    const [daysResult, followupsResult, ordersResult, identitiesResult, conversationsResult] = await Promise.all([
      sequelize.query(
        `SELECT communication_index AS communicationIndex, stage_label AS stageLabel,
                communication_date AS communicationDate, message_count AS messageCount,
                DATE_FORMAT(last_message_at, '%Y-%m-%d %H:%i:%s') AS lastMessageAt
         FROM customer_communication_days WHERE customer_id = :customerId
         ORDER BY communication_date DESC LIMIT 1`, { replacements: replacementBase }
      ),
      sequelize.query(
        `SELECT f.id, f.type, f.status, f.assigned_to AS assignedTo,
                DATE_FORMAT(f.due_at, '%Y-%m-%d %H:%i:%s') AS dueAt,
                f.ai_reason AS aiReason, f.ai_confidence AS aiConfidence,
                f.ai_signals AS aiSignals
         FROM customer_followups f JOIN customers c ON c.id = f.customer_id
         WHERE f.customer_id = :customerId ${ownerFilter}
         ORDER BY f.due_at ASC, f.created_at DESC`, { replacements: replacementBase }
      ),
      sequelize.query(
        `SELECT id, order_no AS orderNo, channel, status, deal_amount AS dealAmount,
                currency, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
         FROM orders WHERE customer_id = :customerId ORDER BY created_at DESC LIMIT 50`, { replacements: replacementBase }
      ),
      sequelize.query(
        `SELECT channel, account_id AS accountId, external_user_id AS externalUserId,
                phone, display_name AS displayName
         FROM customer_identities WHERE customer_id = :customerId`, { replacements: replacementBase }
      ),
      sequelize.query(
        `SELECT DISTINCT cv.id, cv.channel, cv.account_id AS accountId, cv.user_id AS userId,
                cv.claimed_by AS claimedBy, cv.agent_id AS agentId, cv.pool_type AS poolType,
                cv.conv_status AS convStatus,
                DATE_FORMAT(cv.last_message_time, '%Y-%m-%d %H:%i:%s') AS lastMessageTime
         FROM customer_identities ci JOIN conversations cv
           ON cv.channel = ci.channel AND cv.account_id <=> ci.account_id
          AND cv.user_id = ci.external_user_id
         WHERE ci.customer_id = :customerId ${conversationFilter}
         ORDER BY cv.last_message_time DESC`, { replacements: replacementBase }
      )
    ])

    const days = daysResult[0] || []
    const followups = followupsResult[0] || []
    const orders = ordersResult[0] || []
    const identities = identitiesResult[0] || []
    const conversations = conversationsResult[0] || []
    const communicationStage = days[0] || null
    const permissions = {
      canOpenConversation: true,
      canMarkWon: customer.won_status !== 'won',
      canEditProfile: !agent || Number(customer.owner_id) === Number(viewerId),
      canManageFollowups: !agent || Number(customer.owner_id) === Number(viewerId)
    }
    res.json({
      success: true,
      data: {
        customer: { ...customer, ai_profile: parseContextJson(customer.ai_profile, null), languageProfile },
        activeConversation: sourceConversation,
        sourceConversation: { id: sourceConversation.id, channel: sourceConversation.channel, accountId: sourceConversation.account_id, ownerId: sourceConversation.agent_id || sourceConversation.claimed_by || null },
        communicationStage,
        aiProfile: { ...(parseContextJson(customer.ai_profile, {}) || {}), languageProfile },
        followups: followups.map(item => ({ ...item, aiSignals: parseContextJson(item.aiSignals, []) })),
        orders,
        identities,
        conversations,
        permissions,
        generatedAt: new Date().toISOString()
      }
    })
  } catch (err) {
    console.error('[Conversations] customer context failed:', err.message)
    res.status(500).json({ success: false, message: '获取客户上下文失败' })
  }
})

async function findActiveAgent(userId, conversationId) {
  const id = Number(userId)
  if (!Number.isInteger(id) || id <= 0) return null
  const replacements = { id }
  const accountScope = conversationId
    ? `AND EXISTS (
         SELECT 1
         FROM conversations c
         JOIN seat_account_bindings sab
           ON sab.account_id = c.account_id
          AND sab.channel = c.channel
          AND sab.seat_id = users.id
          AND sab.status = 'active'
         WHERE c.id = :conversationId
       )`
    : ''
  if (conversationId) replacements.conversationId = conversationId
  const [rows] = await sequelize.query(
    `SELECT id, username
     FROM users
       WHERE id = :id AND role IN ('agent', 'user') AND status = 'active'
       ${accountScope}
     LIMIT 1`,
    { replacements }
  )
  return rows[0] || null
}

async function getLatestInboundCustomerMessage(conversationId) {
  const [rows] = await sequelize.query(
    `SELECT id, conversation_id, channel, account_id, user_id,
            message_type, content, channel_message_id, created_at
     FROM plat_messages
     WHERE conversation_id = :conversationId
       AND direction = 'inbound'
       AND sender_type = 'customer'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    { replacements: { conversationId } }
  )

  if (rows.length === 0) return null
  const row = rows[0]
  let content = {}
  try {
    content = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content || {})
  } catch (err) {
    content = { text: String(row.content || '') }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel,
    accountId: row.account_id || null,
    channelUserId: row.user_id || null,
    userId: row.user_id || null,
    messageType: row.message_type || content.messageType || 'text',
    content,
    channelMessageId: row.channel_message_id || null,
    createdAt: row.created_at
  }
}

async function enqueueManualAiReply(conversationId, message, eventEmitter = null) {
  if (!message) {
    return { queued: false, reason: '会话没有客户入站消息，已转入 AI 自助池但未触发自动回复' }
  }

  await removePendingAiReplyJobs(conversationId, '手动转AI自助池，保留最新AI回复任务')
  const enqueuedAt = Date.now()
  const jobMarker = `${enqueuedAt}-manual-${Math.random().toString(36).slice(2, 8)}`
  const debounceMs = await configService.getConfig('ai_reply_debounce_ms')
  await markLatestAiReplyJob(conversationId, jobMarker)
  await aiReplyQueue.add('ai-reply', {
    conversationId,
    message,
    enqueuedAt,
    jobMarker
  }, {
    jobId: `ai-${conversationId}-${jobMarker}`,
    delay: debounceMs
  })
  if (eventEmitter) {
    eventEmitter.emit(INTERNAL_EVENTS.AI_REPLY_STATUS, {
      conversationId,
      status: 'queued',
      jobMarker
    })
  }

  return { queued: true }
}

// ========== 国籍字典 ==========
router.get('/nationalities', async (req, res) => {
  try {
    const dictionary = await nationalityService.getNationalityDictionary()
    res.json({
      success: true,
      data: dictionary.map(item => ({
        code: item.code,
        name: item.name,
        name_en: item.nameEn
      }))
    })
  } catch (err) {
    console.error('[Conversations] 查询国籍字典失败:', err.message)
    res.status(500).json({ success: false, message: '查询国籍字典失败' })
  }
})

// ========== 查询会话列表 ==========
router.get('/', async (req, res) => {
  try {
    const { channel, account_id, agent_id, status, search, limit, offset, pool_type, conv_status } = req.query
    const accountId = normalizeConversationAccountId(account_id)

    // 构建查询条件（使用命名替换，避免位置参数错位）
    let whereClause = ''
    const conditions = []
    const namedReplacements = {}

    if (channel) {
      conditions.push('c.channel = :channel')
      namedReplacements.channel = channel
    }
    if (accountId != null) {
      conditions.push('c.account_id = :accountId')
      namedReplacements.accountId = accountId
    }
    if (agent_id) {
      conditions.push('c.agent_id = :agent_id')
      namedReplacements.agent_id = parseInt(agent_id)
    }
    if (pool_type && pool_type !== 'all') {
      if (pool_type === POOL_TYPE.PRIVATE && req.user.role === 'agent') {
        // 普通坐席看私有池只看自己负责且已绑定账号的会话。
        conditions.push(`(
          c.pool_type = :privatePool
          AND c.account_id IN (SELECT account_id FROM seat_account_bindings WHERE seat_id = :user_id AND status = 'active')
          AND (c.claimed_by = :user_id OR c.agent_id = :user_id)
        )`)
        namedReplacements.privatePool = POOL_TYPE.PRIVATE
        namedReplacements.user_id = req.user.id || req.user.userId
      } else if (pool_type === POOL_TYPE.LONG_TERM && req.user.role === 'agent') {
        // 普通坐席看长期跟进池只看自己负责且已绑定账号的会话。
        conditions.push(`(
          c.pool_type = :longTermPool
          AND c.account_id IN (SELECT account_id FROM seat_account_bindings WHERE seat_id = :user_id AND status = 'active')
          AND (c.claimed_by = :user_id OR c.agent_id = :user_id)
        )`)
        namedReplacements.longTermPool = POOL_TYPE.LONG_TERM
        namedReplacements.user_id = req.user.id || req.user.userId
      } else {
        conditions.push('c.pool_type = :pool_type')
        namedReplacements.pool_type = pool_type
        // 普通坐席只能看到自己负责且已绑定账号的会话
        if (req.user.role === 'agent') {
          const agentIdVal = req.user.id || req.user.userId
          conditions.push(`c.account_id IN (
            SELECT account_id FROM seat_account_bindings WHERE seat_id = :user_id AND status = 'active'
          ) AND (c.claimed_by = :user_id OR c.agent_id = :user_id)`)
          namedReplacements.user_id = agentIdVal
        }
      }
    } else if (!pool_type || pool_type === 'all') {
      // 不指定 pool_type 时，按角色过滤可见范围
      if (req.user.role === 'agent') {
        // 普通坐席只看到自己负责且已绑定账号的会话。
        const agentIdVal = req.user.id || req.user.userId
        conditions.push(`(
          c.account_id IN (SELECT account_id FROM seat_account_bindings WHERE seat_id = :user_id AND status = 'active')
          AND (c.claimed_by = :user_id OR c.agent_id = :user_id)
        )`)
        namedReplacements.user_id = agentIdVal
      }
      // supervisor/admin 可以看到所有
    }
    if (conv_status) {
      // 显式指定 conv_status 时（如归档 Tab），用指定值过滤
      conditions.push('c.conv_status = :conv_status')
      namedReplacements.conv_status = conv_status
    } else if (status) {
      conditions.push('c.conv_status = :convStatus')
      namedReplacements.convStatus = status
    } else {
      // 默认排除已归档（非归档 Tab 不显示归档会话）
      conditions.push("c.conv_status != 'archived'")
    }
    if (search) {
      conditions.push('(c.user_name LIKE :search OR c.last_message LIKE :search OR c.user_id LIKE :search)')
      namedReplacements.search = `%${search}%`
    }

    if (conditions.length > 0) {
      whereClause = 'WHERE ' + conditions.join(' AND ')
    }

    const limitVal = parseInt(limit) || 50
    const offsetVal = parseInt(offset) || 0

    const queryReplacements = { ...namedReplacements, limit: limitVal, offset: offsetVal }

    const [rows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.user_avatar, c.agent_id,
              c.nationality_code, c.nationality_source, c.nationality_inferred_at,
              nd.name_zh AS nationality_name, nd.name_en AS nationality_name_en,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at, c.updated_at,
              u.username AS agent_name,
              cu.username AS claimed_by_name,
              ca.account_name, ca.phone_number, ca.whatsapp_name,
              (SELECT COUNT(*) FROM plat_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'outbound' AND pm.sender_type = 'ai' AND pm.send_status = 'sent') AS ai_reply_count,
              (SELECT COUNT(*) FROM plat_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'inbound') AS inbound_count
       FROM conversations c
       LEFT JOIN users u ON c.agent_id = u.id
       LEFT JOIN users cu ON c.claimed_by = cu.id
       LEFT JOIN channel_accounts ca ON c.account_id = ca.id
       LEFT JOIN nationality_dictionary nd ON nd.country_code = c.nationality_code
       ${whereClause}
       ORDER BY
         CASE WHEN c.pool_type = 'pending_human' THEN 0
              WHEN c.pool_type = 'ai_self' THEN 1
              WHEN c.pool_type = 'public' THEN 2
              WHEN c.pool_type = 'private' THEN 3
              WHEN c.pool_type = 'long_term' THEN 4
              ELSE 5 END,
         c.last_message_time DESC, c.created_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements: queryReplacements }
    )
    await attachCustomerPhones(rows)

    // 查询总数
    const [countResult] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM conversations c ${whereClause}`,
      { replacements: namedReplacements }
    )
    const total = countResult[0]?.total || 0

    res.json({
      success: true,
      data: {
        list: rows,
        total,
        limit: limitVal,
        offset: offsetVal
      }
    })
  } catch (err) {
    console.error('[Conversations] 查询会话列表失败:', err.message)
    res.status(err.status || 500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 会话池配置管理 ==========
router.get('/ai-config', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only administrators can view AI configuration' })
    }
    const config = await configService.getPublicAiConfig()
    res.json({ success: true, data: config })
  } catch (error) {
    console.error('[Conversations] Failed to load public AI config:', error.message)
    res.status(500).json({ success: false, message: 'Failed to load AI configuration' })
  }
})

router.put('/ai-config/:key', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only administrators can update AI configuration' })
    }
    if (req.body?.value === undefined) {
      return res.status(400).json({ success: false, message: 'value is required' })
    }
    const operatorId = req.user.id || req.user.userId
    const result = await configService.updatePublicAiConfig(req.params.key, req.body.value, operatorId)
    if (!result.success) return res.status(500).json({ success: false, message: result.message })
    res.json({ success: true, message: 'AI configuration updated' })
  } catch (error) {
    if (/not editable|must be/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message })
    }
    console.error('[Conversations] Failed to update public AI config:', error.message)
    res.status(500).json({ success: false, message: 'Failed to update AI configuration' })
  }
})

function requireAiProviderAdmin(req, res) {
  if (req.user.role === 'admin') return true
  res.status(403).json({ success: false, message: 'Only administrators can manage AI providers' })
  return false
}

function aiProviderService() {
  return require('../modules/ai-provider/providerService').getProviderService()
}

router.get('/ai-provider', async (req, res) => {
  if (!requireAiProviderAdmin(req, res)) return
  try { res.json({ success: true, data: await aiProviderService().getStatus() }) }
  catch (error) { res.status(500).json({ success: false, message: error.message }) }
})

router.put('/ai-provider', async (req, res) => {
  if (!requireAiProviderAdmin(req, res)) return
  try {
    const result = await aiProviderService().saveCredential(req.body?.apiKey, req.user.id || req.user.userId)
    if (!result.success) throw new Error(result.message)
    res.json({ success: true, data: await aiProviderService().getStatus() })
  } catch (error) { res.status(400).json({ success: false, message: error.message }) }
})

router.delete('/ai-provider/credential', async (req, res) => {
  if (!requireAiProviderAdmin(req, res)) return
  try {
    const result = await aiProviderService().clearCredential(req.user.id || req.user.userId)
    if (!result.success) throw new Error(result.message)
    res.json({ success: true, data: await aiProviderService().getStatus() })
  } catch (error) { res.status(400).json({ success: false, message: error.message }) }
})

router.post('/ai-provider/test', async (req, res) => {
  if (!requireAiProviderAdmin(req, res)) return
  try { res.json({ success: true, data: await aiProviderService().testConnection(req.body?.apiKey) }) }
  catch (error) { res.status(400).json({ success: false, message: error.message }) }
})

router.post('/ai-provider/models/sync', async (req, res) => {
  if (!requireAiProviderAdmin(req, res)) return
  try { res.json({ success: true, data: await aiProviderService().syncModels() }) }
  catch (error) { res.status(400).json({ success: false, message: error.message }) }
})

router.get('/ai-provider/balance', async (req, res) => {
  if (!requireAiProviderAdmin(req, res)) return
  try { res.json({ success: true, data: await aiProviderService().getBalance() }) }
  catch (error) { res.status(400).json({ success: false, message: error.message }) }
})

/**
 * GET /api/v1/conversations/pool-config
 * 获取全部会话池配置（admin 权限）
 * 使用 ConfigService（Redis 缓存 + MySQL 回源）
 */
router.get('/pool-config', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '仅管理员可查看池配置' })
    }
    const config = await configService.getAllConfig()
    res.json({ success: true, data: config })
  } catch (err) {
    console.error('[Conversations] 获取池配置失败:', err.message)
    res.status(500).json({ success: false, message: '获取配置失败: ' + err.message })
  }
})

/**
 * PUT /api/v1/conversations/pool-config/:key
 * 更新某个会话池配置项（admin 权限）
 * 更新后自动清除 Redis 缓存 + Pub/Sub 通知
 */
router.put('/pool-config/:key', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '仅管理员可修改池配置' })
    }
    const { key } = req.params
    const { value } = req.body
    const updatedBy = req.user.id || req.user.userId

    if (value === undefined) {
      return res.status(400).json({ success: false, message: 'value 不能为空' })
    }

    const result = await configService.updateConfig(key, value, updatedBy)
    if (result.success) {
      res.json({ success: true, message: '配置已更新，实时生效' })
    } else {
      res.status(500).json({ success: false, message: result.message })
    }
  } catch (err) {
    console.error('[Conversations] 更新池配置失败:', err.message)
    res.status(500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

// ========== AI 回复队列监控 ==========
/**
 * GET /api/v1/conversations/queue-stats
 * 返回 AI 回复队列的实时监控指标（从 BullMQ 获取）
 * 注意：必须在 /:id 之前注册
 */
router.get('/queue-stats', async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '仅管理员/主管可查看队列状态' })
    }
    const stats = await getQueueStats()
    res.json({ success: true, data: stats })
  } catch (err) {
    console.error('[Conversations] 获取队列统计失败:', err.message)
    res.status(500).json({ success: false, message: '获取队列统计失败: ' + err.message })
  }
})

// ========== AI 回复业务日志 ==========
/**
 * GET /api/v1/conversations/ai-reply-logs
 * 查询 AI 回复业务日志（成功/失败/转人工记录）
 * 注意：必须在 /:id 之前注册
 */
router.get('/ai-reply-logs', async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '仅管理员/主管可查看AI日志' })
    }
    const { conversation_id, status, limit = 50, offset = 0 } = req.query

    const conditions = []
    const replacements = {}

    if (conversation_id) {
      conditions.push('conversation_id = :conversation_id')
      replacements.conversation_id = conversation_id
    }
    if (status) {
      conditions.push('status = :status')
      replacements.status = status
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

    const [rows] = await sequelize.query(
      `SELECT * FROM ai_reply_logs ${whereClause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit: parseInt(limit), offset: parseInt(offset) } }
    )

    const [countResult] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM ai_reply_logs ${whereClause}`,
      { replacements }
    )

    res.json({
      success: true,
      data: { list: rows, total: countResult[0]?.total || 0 }
    })
  } catch (err) {
    console.error('[Conversations] 查询AI日志失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== AI 推荐可用模型（公开） ==========
/**
 * GET /api/v1/conversations/ai-suggest-models
 * 返回客服工作台 AI 推荐可选的模型列表
 * 无需 admin 权限，坐席也可访问
 * 注意：必须在 /:id 之前注册
 */
router.get('/ai-suggest-models', async (req, res) => {
  try {
    const models = await configService.getConfig('llm_suggest_models')
    res.json({ success: true, data: models || ['qwen3.7-plus'] })
  } catch (err) {
    console.error('[Conversations] 获取AI推荐模型失败:', err.message)
    res.json({ success: true, data: ['qwen3.7-plus'] })
  }
})

// ========== 各池数量统计 ==========
/**
 * GET /api/v1/conversations/pool-stats
 * 返回各池的会话数量，用于前端 Tab 角标
 * 注意：必须在 /:id 之前注册，否则会被 /:id 捕获
 */
router.get('/pool-stats', async (req, res) => {
  try {
    const seatId = req.user.id || req.user.userId
    const stats = await poolService.getPoolStats(seatId, req.user.role)
    res.json({ success: true, data: stats })
  } catch (err) {
    console.error('[Conversations] 获取池统计失败:', err.message)
    res.status(500).json({ success: false, message: '获取统计失败: ' + err.message })
  }
})

// ========== 池操作日志 ==========
/**
 * GET /api/v1/conversations/pool-logs
 * 查询池操作日志（supervisor/admin 权限）
 */
router.get('/pool-logs', async (req, res) => {
  try {
    if (!['supervisor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '无权限查看操作日志' })
    }

    const { conversationId, action, actions, operatorId, operatorType, fromPool, toPool, startDate, endDate, limit, offset } = req.query
    const result = await poolService.getPoolLogs({
      conversationId,
      action,
      actions: actions ? (Array.isArray(actions) ? actions : actions.split(',')) : null,
      operatorId: operatorId ? parseInt(operatorId) : null,
      operatorType,
      fromPool,
      toPool,
      startDate,
      endDate,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    })

    res.json({ success: true, data: result })
  } catch (err) {
    console.error('[Conversations] 查询操作日志失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 获取坐席负载 ==========
/**
 * GET /api/v1/conversations/seat-load
 */
router.get('/seat-load', async (req, res) => {
  try {
    const seatId = req.user.id || req.user.userId
    const capacity = await poolService.checkSeatCapacity(seatId)
    res.json({ success: true, data: capacity })
  } catch (err) {
    console.error('[Conversations] 获取坐席负载失败:', err.message)
    res.status(500).json({ success: false, message: '获取失败: ' + err.message })
  }
})

// ========== 可分配坐席 ==========
/**
 * GET /api/v1/conversations/assignable-seats
 * 管理员/主管分配会话时使用
 */
router.get('/assignable-seats', async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '仅管理员/主管可查看可分配坐席' })
    }

    const [rows] = await sequelize.query(
      `SELECT u.id, u.username, u.email, u.role, u.status,
              COALESCE(ss.status, 'offline') AS seat_status
       FROM users u
       LEFT JOIN seat_status ss ON ss.user_id = u.id
       WHERE u.role IN ('agent', 'user')
         AND u.status = 'active'
       ORDER BY u.username ASC`
    )

    const seats = await Promise.all(rows.map(async row => {
      const capacity = await poolService.checkSeatCapacity(row.id)
      return {
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role,
        status: row.status,
        seatStatus: row.seat_status,
        current: capacity.current,
        max: capacity.max,
        canClaim: capacity.canClaim
      }
    }))

    res.json({ success: true, data: seats })
  } catch (err) {
    console.error('[Conversations] 获取可分配坐席失败:', err.message)
    res.status(500).json({ success: false, message: '获取可分配坐席失败: ' + err.message })
  }
})

// ========== 更新坐席状态 ==========
/**
 * POST /api/v1/conversations/seat-status
 */
router.post('/seat-status', async (req, res) => {
  try {
    const { status } = req.body
    const seatId = req.user.id || req.user.userId

    const validStatuss = ['online', 'offline', 'away', 'busy']
    if (!validStatuss.includes(status)) {
      return res.status(400).json({ success: false, message: '无效的状态' })
    }

    await poolService.updateSeatStatus(seatId, status)

    if (status === 'offline') {
      const offlineReleaseEnabled = await poolService.isSeatOfflineReleaseEnabled()
      if (!offlineReleaseEnabled) {
        return res.json({
          success: true,
          message: '已离线，坐席离线自动释放已关闭',
          data: { releasedCount: 0, offlineReleaseEnabled }
        })
      }
      const releasedCount = await poolService.releaseOnSeatOffline(seatId, req.eventEmitter)
      res.json({ success: true, message: `已离线，自动释放 ${releasedCount} 个会话`, data: { releasedCount } })
    } else {
      res.json({ success: true, message: '状态已更新' })
    }
  } catch (err) {
    console.error('[Conversations] 更新坐席状态失败:', err.message)
    res.status(500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

// ========== 全局搜索会话（跨所有池/所有坐席/含消息内容） ==========
/**
 * GET /api/v1/conversations/search?q=keyword&limit=50&offset=0&start_date=&end_date=
 * 全局搜索：搜索范围包括会话字段(user_name/last_message/user_id) + 消息内容(text/translatedText)
 * 普通坐席仅可搜索自己绑定账号下可见会话；主管/管理员可搜索全部会话。
 * 可选时间范围：start_date / end_date（ISO 日期），同时过滤会话最后消息时间和消息内容时间
 * 返回 match_type(conversation/message) + matched_text(消息匹配时的文本预览)
 */
router.get('/search', async (req, res) => {
  try {
    const { q, limit, offset, start_date, end_date } = req.query
    const keyword = (q || '').trim()

    if (!keyword) {
      return res.json({ success: true, data: { list: [], total: 0, limit: 50, offset: 0 } })
    }

    const likeSearch = `%${keyword}%`
    const limitVal = Math.min(parseInt(limit) || 50, 200)
    const offsetVal = parseInt(offset) || 0

    // 构建时间范围条件
    const timeConditions = []
    const replacements = { search: likeSearch, limit: limitVal, offset: offsetVal }

    if (start_date) {
      timeConditions.push('COALESCE(c.last_message_time, c.created_at) >= :start_date')
      replacements.start_date = start_date
    }
    if (end_date) {
      timeConditions.push('COALESCE(c.last_message_time, c.created_at) <= :end_date')
      replacements.end_date = end_date + ' 23:59:59'
    }
    const timeClause = timeConditions.length > 0
      ? 'AND ' + timeConditions.join(' AND ')
      : ''
    const visibilityConditions = []
    addAgentVisibilityCondition(req, visibilityConditions, replacements)
    const visibilityClause = visibilityConditions.length > 0
      ? 'AND ' + visibilityConditions.join(' AND ')
      : ''

    // 消息内容搜索的时间过滤（与外层时间范围一致）
    let msgTimeFilter = ''
    if (start_date) {
      msgTimeFilter += ' AND pm.created_at >= :start_date'
    }
    if (end_date) {
      msgTimeFilter += ' AND pm.created_at <= :end_date'
    }

    // 搜索条件：会话字段 OR 消息内容
    const matchCondition = `(
      c.user_name LIKE :search
      OR c.last_message LIKE :search
      OR c.user_id LIKE :search
      OR EXISTS (
        SELECT 1 FROM plat_messages pm
        WHERE pm.conversation_id = c.id
          AND (
            pm.content->>'$.text' LIKE :search
            OR pm.content->>'$.translatedText' LIKE :search
          )
          ${msgTimeFilter}
      )
    )`

    // 查询匹配的会话（含 match_type 和 matched_text）
    const [rows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.user_avatar, c.agent_id,
              c.nationality_code, c.nationality_source, c.nationality_inferred_at,
              nd.name_zh AS nationality_name, nd.name_en AS nationality_name_en,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at, c.updated_at,
              u.username AS agent_name,
              cu.username AS claimed_by_name,
              ca.account_name, ca.phone_number, ca.whatsapp_name,
              CASE
                WHEN c.user_name LIKE :search OR c.last_message LIKE :search OR c.user_id LIKE :search
                THEN 'conversation'
                ELSE 'message'
              END AS match_type,
              (SELECT SUBSTRING(COALESCE(pm2.content->>'$.translatedText', pm2.content->>'$.text'), 1, 200)
               FROM plat_messages pm2
               WHERE pm2.conversation_id = c.id
                 AND (
                   pm2.content->>'$.text' LIKE :search
                   OR pm2.content->>'$.translatedText' LIKE :search
                 )
               ${msgTimeFilter.replace(/pm\./g, 'pm2.')}
               ORDER BY pm2.created_at DESC LIMIT 1) AS matched_text
       FROM conversations c
       LEFT JOIN users u ON c.agent_id = u.id
       LEFT JOIN users cu ON c.claimed_by = cu.id
       LEFT JOIN channel_accounts ca ON c.account_id = ca.id
       LEFT JOIN nationality_dictionary nd ON nd.country_code = c.nationality_code
       WHERE ${matchCondition} ${timeClause} ${visibilityClause}
       ORDER BY c.last_message_time DESC, c.created_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    await attachCustomerPhones(rows)

    // 查询总数
    const [countResult] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM conversations c WHERE ${matchCondition} ${timeClause} ${visibilityClause}`,
      { replacements }
    )
    const total = countResult[0]?.total || 0

    res.json({
      success: true,
      data: { list: rows, total, limit: limitVal, offset: offsetVal }
    })
  } catch (err) {
    console.error('[Conversations] 全局搜索失败:', err.message)
    res.status(500).json({ success: false, message: '搜索失败: ' + err.message })
  }
})

// ========== 查询单个会话详情 ==========
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    if (!await requireConversationAccess(req, res, id)) return

    const [rows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.user_avatar, c.agent_id,
              c.nationality_code, c.nationality_source, c.nationality_inferred_at,
              nd.name_zh AS nationality_name, nd.name_en AS nationality_name_en,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at, c.updated_at,
              c.follow_up_reminder_at,
              u.username AS agent_name,
              cu.username AS claimed_by_name,
              ca.account_name, ca.phone_number, ca.whatsapp_name
       FROM conversations c
       LEFT JOIN users u ON c.agent_id = u.id
       LEFT JOIN users cu ON c.claimed_by = cu.id
       LEFT JOIN channel_accounts ca ON c.account_id = ca.id
       LEFT JOIN nationality_dictionary nd ON nd.country_code = c.nationality_code
       WHERE c.id = :id`,
      { replacements: { id } }
    )

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    await attachCustomerPhones(rows)

    res.json({ success: true, data: rows[0] })
  } catch (err) {
    console.error('[Conversations] 查询会话详情失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 更新会话 ==========
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { agent_id, status, user_name, nationality_code } = req.body
    if (!await requireConversationAccess(req, res, id)) return

    const updates = []
    const replacements = {}

    if (agent_id !== undefined) {
      if (!['supervisor', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: '无权重新分配会话' })
      }
      if (agent_id && !await findActiveAgent(agent_id, id)) {
        return res.status(400).json({ success: false, message: '目标客服不存在或不可用' })
      }
      updates.push('agent_id = :agent_id')
      replacements.agent_id = agent_id || null
    }
    if (status !== undefined) {
      updates.push('status = :status')
      replacements.status = status
    }
    if (user_name !== undefined) {
      updates.push('user_name = :user_name')
      replacements.user_name = user_name
    }

    if (updates.length === 0 && nationality_code === undefined) {
      return res.status(400).json({ success: false, message: '无更新字段' })
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()')
      replacements.id = id
      await sequelize.query(
        `UPDATE conversations SET ${updates.join(', ')} WHERE id = :id`,
        { replacements }
      )
    }

    const nationality = nationality_code !== undefined
      ? await nationalityService.updateConversationNationality(id, nationality_code)
      : undefined

    res.json({ success: true, message: '会话更新成功', data: nationality })
  } catch (err) {
    console.error('[Conversations] 更新会话失败:', err.message)
    res.status(err.statusCode || 500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

// ========== 手动重新推测国籍（允许覆盖当前值） ==========
router.post('/:id/infer-nationality', async (req, res) => {
  try {
    const { id } = req.params
    if (!await requireConversationAccess(req, res, id)) return

    const result = await nationalityService.inferConversationNationality(id, null, { force: true })
    if (!result.inferred) {
      return res.json({ success: true, message: '当前手机号或会话语言不足以推测国籍，已保留原值', data: null })
    }
    res.json({ success: true, message: '国籍推测完成', data: result.data })
  } catch (err) {
    console.error('[Conversations] 手动推测国籍失败:', err.message)
    res.status(500).json({ success: false, message: '国籍推测失败' })
  }
})

// ========== 标记会话已读（清零未读数） ==========
router.post('/:id/read', async (req, res) => {
  try {
    const { id } = req.params
    if (!await requireConversationAccess(req, res, id)) return

    await sequelize.query(
      `UPDATE conversations SET unread_count = 0, updated_at = NOW() WHERE id = :id`,
      { replacements: { id } }
    )

    res.json({ success: true, message: '已标记已读' })
  } catch (err) {
    console.error('[Conversations] 标记已读失败:', err.message)
    res.status(500).json({ success: false, message: '操作失败: ' + err.message })
  }
})

// ========== 查询会话消息历史 ==========
router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params
    const { limit, offset, direction } = req.query

    if (!await requireConversationAccess(req, res, id)) return

    let whereClause = 'WHERE conversation_id = :id'
    const namedReplacements = { id }
    if (direction) {
      whereClause += ' AND direction = :direction'
      namedReplacements.direction = direction
    }

    const limitVal = parseInt(limit) || 200
    const offsetVal = parseInt(offset) || 0
    namedReplacements.limit = limitVal
    namedReplacements.offset = offsetVal

    // 先查总数（用于前端判断是否还有更多历史消息）
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) as total FROM plat_messages ${whereClause}`,
      { replacements: namedReplacements }
    )
    const totalCount = countRows[0]?.total || 0

    // 取最新的 N 条消息（DESC LIMIT），再按时间正序排列（ASC）供前端展示
    // 这样聊天窗口始终展示最新消息，而不是最旧的
    const [rows] = await sequelize.query(
      `SELECT * FROM (
         SELECT id, conversation_id, channel, direction, sender_type, message_type, content,
                send_status, created_at
         FROM plat_messages
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset
       ) AS sub
       ORDER BY created_at ASC`,
      { replacements: namedReplacements }
    )

    // 解析 content JSON
    const messages = rows.map(row => {
      let contentObj = {}
      try {
        contentObj = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content || {})
      } catch {
        contentObj = { text: String(row.content || '') }
      }
      return {
        id: row.id,
        conversationId: row.conversation_id,
        channel: row.channel,
        direction: row.direction,
        senderType: row.sender_type,
        messageType: row.message_type,
        content: contentObj,
        sendStatus: row.send_status,
        createdAt: row.created_at
      }
    })

    res.json({ success: true, data: { list: messages, total: totalCount, returned: messages.length } })
  } catch (err) {
    console.error('[Conversations] 查询消息历史失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 发送消息 ==========
// Translation preview: translate text for a conversation without persisting or sending it.
router.post('/:id/translation-preview', async (req, res) => {
  try {
    const { id } = req.params
    if (!await requireConversationAccess(req, res, id)) return

    const text = String(req.body?.text || req.body?.content || '').trim()
    if (!text) return res.status(400).json({ success: false, message: '请输入需要翻译的文本' })
    if (text.length > 10000) return res.status(400).json({ success: false, message: '文本长度不能超过10000个字符' })

    const requestedTarget = String(req.body?.targetLanguage || req.body?.target_language || 'customer').trim()
    const customerLanguage = await languageGuard.resolveCustomerLanguage(id)
    let targetCode = customerLanguage.code || 'zh'
    let targetLabel = customerLanguage.label || targetCode
    if (requestedTarget && requestedTarget !== 'customer' && requestedTarget !== 'follow_customer') {
      targetCode = requestedTarget
      targetLabel = languageGuard.languageLabelFromCode(requestedTarget)
    }

    const detected = await translationService.detectLanguage(text)
    if (detected.lang === targetCode) {
      return res.json({
        success: true,
        data: { originalText: text, translatedText: text, sourceLanguage: detected.lang, targetLanguageCode: targetCode, targetLanguageLabel: targetLabel, translated: false }
      })
    }

    const rawContextCount = await configService.getConfig('translation_context_message_count')
    const contextCount = Math.max(0, Math.min(parseInt(rawContextCount, 10) || 0, 10))
    const contextMessages = contextCount > 0 ? await messagingService.getConversationContext(id, contextCount) : []
    const translateModel = await configService.getConfig('llm_translate_model')
    const translatedText = targetCode === 'zh'
      ? await translationService.translateToChinese(text, detected.label || detected.lang, translateModel, { contextMessages, throwOnError: true })
      : await translationService.translateFromChinese(text, targetLabel, translateModel, { contextMessages, throwOnError: true })

    return res.json({
      success: true,
      data: { originalText: text, translatedText: String(translatedText || text), sourceLanguage: detected.lang, sourceLanguageLabel: detected.label, targetLanguageCode: targetCode, targetLanguageLabel: targetLabel, translated: true, contextMessageCount: contextMessages.length }
    })
  } catch (err) {
    console.error('[Conversations] translation preview failed:', err.message)
    return res.status(502).json({ success: false, message: '翻译预览失败，请稍后重试' })
  }
})

router.post('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params
    const { content, messageType, translateToCustomerLanguage = false } = req.body
    const agentId = req.user.id || req.user.userId
    if (!await requireConversationAccess(req, res, id)) return

    if (!content) {
      return res.status(400).json({ success: false, message: '消息内容不能为空' })
    }

    // 检查会话是否存在
    const [convRows] = await sequelize.query(
      `SELECT id, channel, account_id, user_id FROM conversations WHERE id = :id`,
      { replacements: { id } }
    )
    if (convRows.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    const conv = convRows[0]
    let messageContent = typeof content === 'string' ? { text: content } : content
    let translation = {
      requested: translateToCustomerLanguage === true,
      applied: false,
      targetLanguageCode: null,
      targetLanguageLabel: null,
      contextMessageCount: 0
    }

    if (translateToCustomerLanguage === true) {
      if ((messageType || 'text') !== 'text') {
        return res.status(400).json({ success: false, message: '翻译并发送目前仅支持文字消息' })
      }

      const sourceText = String(messageContent?.text || '').trim()
      if (!sourceText) {
        return res.status(400).json({ success: false, message: '请输入需要翻译的文字' })
      }

      const [customerMessageRows] = await sequelize.query(
        `SELECT id FROM plat_messages
         WHERE conversation_id = :conversationId
           AND direction = 'inbound'
           AND sender_type = 'customer'
           AND message_type = 'text'
         ORDER BY created_at DESC
         LIMIT 1`,
        { replacements: { conversationId: id } }
      )
      if (customerMessageRows.length === 0) {
        return res.status(422).json({
          success: false,
          message: '暂无客户文字消息，无法判断目标语言，消息未发送'
        })
      }

      const customerLanguage = await languageGuard.resolveCustomerLanguage(id)
      translation.targetLanguageCode = customerLanguage.code || null
      translation.targetLanguageLabel = customerLanguage.label || null

      if (customerLanguage.group === 'other') {
        if (!customerLanguage.code || ['other', 'unknown'].includes(customerLanguage.code)) {
          return res.status(422).json({
            success: false,
            message: '暂时无法识别客户语言，请确认客户最近发送过可识别的文字消息'
          })
        }

        const translateModel = await configService.getConfig('llm_translate_model')
        const rawTimeoutMs = await configService.getConfig('ai_timeout_ms')
        const timeoutMs = Math.max(1000, Math.min(parseInt(rawTimeoutMs, 10) || 30000, 60000))
        const rawContextCount = await configService.getConfig('translation_context_message_count')
        const contextCount = Math.max(0, Math.min(parseInt(rawContextCount, 10) || 0, 10))
        const contextMessages = contextCount > 0
          ? await messagingService.getConversationContext(id, contextCount)
          : []

        let translatedText = ''
        try {
          translatedText = await translationService.translateFromChinese(
            sourceText,
            customerLanguage.label || customerLanguage.code,
            translateModel,
            { contextMessages, throwOnError: true, timeoutMs }
          )
        } catch (translationErr) {
          console.error(
            `[Conversations] 坐席消息翻译失败 (conv=${id}, target=${customerLanguage.code}):`,
            translationErr.message
          )
          return res.status(502).json({
            success: false,
            message: '翻译失败，消息未发送，请稍后重试'
          })
        }

        translatedText = String(translatedText || '').trim()
        if (!translatedText || (translatedText === sourceText && /[\u4e00-\u9fff]/.test(sourceText))) {
          return res.status(502).json({
            success: false,
            message: '翻译未产生有效译文，消息未发送，请稍后重试'
          })
        }

        messageContent = {
          ...messageContent,
          text: translatedText,
          translatedText: sourceText,
          originalLang: customerLanguage.code,
          langLabel: customerLanguage.label || customerLanguage.code,
          translated: true,
          translationSource: 'agent_manual'
        }
        translation = {
          ...translation,
          applied: true,
          contextMessageCount: contextMessages.length
        }
        console.log(
          `[Conversations] 坐席消息已翻译 (conv=${id}, target=${customerLanguage.code}, ` +
          `context=${contextMessages.length}, sourceLength=${sourceText.length}, translatedLength=${translatedText.length})`
        )
      }
    }

    const claimResult = await poolService.ensureClaimedForReply(
      id,
      agentId,
      req.user.username || `用户${agentId}`,
      req.eventEmitter
    )
    if (!claimResult.success) {
      return res.status(409).json({
        success: false,
        message: claimResult.message || '回复前认领会话失败'
      })
    }

    // WhatsApp 外发：使用会话所属账号发送（conv.account_id 决定 WAHA 实例）
    let outboundAccountId = conv.account_id
    if (conv.channel === 'whatsapp' && !conv.account_id) {
      return res.status(400).json({
        success: false,
        message: '当前会话未关联 WhatsApp 账号，无法发送消息。请先同步或修复该会话的账号归属。'
      })
    }

    // 1. 先入库（状态 pending）
    const message = {
      conversationId: id,
      content: messageContent,
      messageType: messageType || 'text',
      agentId,
      accountId: outboundAccountId,
      channel: conv.channel,
      channelUserId: conv.user_id,
      userName: conv.user_name
    }
    const result = await messagingService.sendOutboundMessage(message, req.eventEmitter)

    // 2. 通过渠道适配器真正发送消息；普通手动发送不改写语言，只有显式翻译按钮会使用上面的译文。
    let sendResult = { success: true }
    let actualOutboundAccountId = outboundAccountId
    const cloudDispatcher = req.app.get('cloudGateway')?.dispatcher
    const cloudPayload = {
      conversationId: id,
      localMessageId: result.messageId,
      channel: conv.channel,
      accountId: outboundAccountId,
      targetUserId: conv.user_id,
      messageType: messageType || 'text',
      content: messageContent
    }
    if (cloudDispatcher) {
      try {
        sendResult = await cloudDispatcher.dispatch(cloudPayload)
        if (!sendResult.success && conv.channel === 'whatsapp' && isSelfRecipientSendResult(sendResult)) {
          const alternateAccount = await findAlternateBoundWhatsappAccount(agentId, outboundAccountId)
          if (alternateAccount && sendResult.resolvedChatId) {
            const retryResult = await cloudDispatcher.dispatch({
              ...cloudPayload,
              accountId: alternateAccount.id,
              targetUserId: sendResult.resolvedChatId
            })
            if (retryResult.success) {
              actualOutboundAccountId = alternateAccount.id
              sendResult = {
                ...retryResult,
                fallbackAccountId: alternateAccount.id,
                originalAccountId: outboundAccountId,
                originalError: sendResult.error,
                retryReason: 'self_recipient_alternate_bound_account'
              }
            } else {
              sendResult = { ...retryResult, error: `${sendResult.error}; alternate bound account ${alternateAccount.id} retry failed: ${retryResult.error || 'unknown error'}` }
            }
          } else if (!alternateAccount) {
            sendResult.error = `${sendResult.error}; no alternate active WhatsApp account is bound to this seat`
          } else {
            sendResult.error = `${sendResult.error}; self recipient did not provide a resolved retry chatId`
          }
        }
      } catch (cloudErr) {
        sendResult = { success: false, error: cloudErr.message, status: 'failed' }
      }
    } else if (conv.channel === 'whatsapp') {
      try {
        const { getAdapterByChannel } = require('../modules/channel-adapters')
        const adapter = getAdapterByChannel('whatsapp')
        if (adapter) {
          sendResult = await adapter.sendMessage(
            outboundAccountId,
            conv.user_id,
            { content: messageContent, messageType: messageType || 'text' }
          )

          if (!sendResult.success && isSelfRecipientSendResult(sendResult)) {
            const alternateAccount = await findAlternateBoundWhatsappAccount(agentId, outboundAccountId)
            if (alternateAccount && sendResult.resolvedChatId) {
              console.warn(
                `[Conversations] WAHA self-recipient detected (conv=${id}, account=${outboundAccountId}); ` +
                `retrying with bound account ${alternateAccount.id}`
              )
              const retryResult = await adapter.sendMessage(
                alternateAccount.id,
                sendResult.resolvedChatId,
                { content: messageContent, messageType: messageType || 'text' }
              )
              if (retryResult.success) {
                actualOutboundAccountId = alternateAccount.id
                sendResult = {
                  ...retryResult,
                  fallbackAccountId: alternateAccount.id,
                  originalAccountId: outboundAccountId,
                  originalError: sendResult.error,
                  retryReason: 'self_recipient_alternate_bound_account'
                }
              } else {
                sendResult = {
                  ...retryResult,
                  error: `${sendResult.error}; alternate bound account ${alternateAccount.id} retry failed: ${retryResult.error || 'unknown error'}`
                }
              }
            } else if (!alternateAccount) {
              sendResult.error = `${sendResult.error}; no alternate active WhatsApp account is bound to this seat`
            } else {
              sendResult.error = `${sendResult.error}; self recipient did not provide a resolved retry chatId`
            }
          }

          if (!sendResult.success) {
            console.error(`[Conversations] WAHA 发送失败 (conv=${id}):`, sendResult.error)
          } else {
            console.log(`[Conversations] WAHA 发送成功 (conv=${id}, channelMsgId=${sendResult.channelMsgId})`)
          }
        } else {
          console.error('[Conversations] WhatsApp 适配器未初始化')
          sendResult = { success: false, error: 'WhatsApp 适配器未初始化' }
        }
      } catch (wahaErr) {
        console.error('[Conversations] WAHA 发送异常:', wahaErr.message)
        sendResult = { success: false, error: wahaErr.message }
      }
    }
    // TODO: 后续扩展其他渠道（微信、抖音等）

    // 3. 更新消息的渠道发送状态
    if (result.messageId) {
      try {
        const finalSendStatus = sendResult.status === 'accepted' ? 'received' : (sendResult.success ? 'sent' : 'failed')
        const channelMsgId = sendResult.channelMsgId ? String(sendResult.channelMsgId) : null
        await sequelize.query(
          `UPDATE plat_messages
           SET channel_message_id = :channelMsgId, send_status = :sendStatus,
               account_id = :actualOutboundAccountId,
               updated_at = NOW()
           WHERE id = :messageId`,
          {
            replacements: {
              channelMsgId,
              sendStatus: finalSendStatus,
              actualOutboundAccountId,
              messageId: result.messageId
            }
          }
        )
        if (req.eventEmitter) {
          const { INTERNAL_EVENTS } = require('../modules/websocket/events')
          req.eventEmitter.emit(INTERNAL_EVENTS.MESSAGE_UPDATE, {
            conversationId: id,
            messageId: result.messageId,
            sendStatus: finalSendStatus,
            channelMsgId,
            accountId: actualOutboundAccountId
          })
        }
      } catch (updateErr) {
        console.error('[Conversations] 更新发送状态失败:', updateErr.message)
      }
    }

    if (!sendResult.success) {
      return res.status(502).json({
        success: false,
        message: '消息已记录但发送到 WhatsApp 失败: ' + (sendResult.error || '未知错误'),
        data: {
          ...result,
          content: messageContent,
          translation,
          accountId: actualOutboundAccountId,
          channelMsgId: sendResult.channelMsgId ? String(sendResult.channelMsgId) : null,
          sendStatus: 'failed'
        }
      })
    }

    res.json({
      success: true,
      message: '消息发送成功',
      data: {
        ...result,
        content: messageContent,
        translation,
        accountId: actualOutboundAccountId,
        channelMsgId: sendResult.channelMsgId ? String(sendResult.channelMsgId) : null,
        sendStatus: sendResult.status === 'accepted' ? 'received' : (sendResult.success ? 'sent' : 'failed'),
        fallbackAccountId: sendResult.fallbackAccountId || null,
        originalAccountId: sendResult.originalAccountId || null,
        retryReason: sendResult.retryReason || null
      }
    })
  } catch (err) {
    console.error('[Conversations] 发送消息失败:', err.message)
    res.status(500).json({ success: false, message: '发送失败: ' + err.message })
  }
})

// ========== 分配/转接会话给坐席 ==========
router.post('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params
    const { agent_id, previous_agent_id } = req.body
    if (!['supervisor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '无权分配会话' })
    }
    if (!await requireConversationAccess(req, res, id)) return

    if (!agent_id) {
      return res.status(400).json({ success: false, message: 'agent_id 不能为空' })
    }
    if (!await findActiveAgent(agent_id, id)) {
      return res.status(400).json({ success: false, message: '目标客服不存在或不可用' })
    }

    const result = await messagingService.assignConversation(
      id, agent_id, previous_agent_id || null, req.eventEmitter
    )

    res.json({ success: true, message: '会话分配成功', data: result })
  } catch (err) {
    console.error('[Conversations] 分配会话失败:', err.message)
    res.status(500).json({ success: false, message: '分配失败: ' + err.message })
  }
})

// ========== 头像获取 ==========
/**
 * POST /api/v1/conversations/:id/fetch-avatar
 * 手动触发/刷新单个会话的联系人头像
 * body: { force?: boolean } - true 强制刷新（忽略已有头像）
 */
router.post('/:id/fetch-avatar', async (req, res) => {
  try {
    const { id } = req.params
    const { force = false } = req.body
    if (!await requireConversationAccess(req, res, id)) return

    const [convRows] = await sequelize.query(
      `SELECT id, account_id, user_id, channel FROM conversations WHERE id = :id`,
      { replacements: { id } }
    )
    if (convRows.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    const conv = convRows[0]
    if (conv.channel !== 'whatsapp') {
      return res.status(400).json({ success: false, message: '当前仅支持 WhatsApp 头像获取' })
    }

    const result = await avatarService.ensureAvatar(id, conv.account_id, conv.user_id, { force })

    res.json({
      success: result.success,
      message: result.reason,
      data: { avatar: result.avatar }
    })
  } catch (err) {
    console.error('[Conversations] 获取头像失败:', err.message)
    res.status(500).json({ success: false, message: '获取头像失败: ' + err.message })
  }
})

/**
 * POST /api/v1/conversations/batch-fetch-avatars
 * 批量为没有头像的 WhatsApp 会话获取头像（回填）
 * body: { batchSize?: number }
 */
router.post('/batch-fetch-avatars', async (req, res) => {
  let ownsBatchJob = false
  let sharedLease = null
  try {
    if (!['supervisor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '无权执行全量头像同步' })
    }
    const { batchSize = 20, account_id: accountId } = req.body
    const safeBatchSize = boundedInteger(batchSize, { fallback: 20, max: 50 })
    if (!await requirePrivilegedAccountScope(req, res, accountId)) return
    if (!enforcePrivilegedActionRateLimit(req, res, 'batch-fetch-avatars')) return
    if (batchAvatarJobOwner !== null) {
      return res.status(409).json({ success: false, message: '头像批量任务正在运行' })
    }
    sharedLease = await acquireSharedLease('conversation-jobs:batch-avatar')
    if (!sharedLease) {
      return res.status(409).json({ success: false, message: '头像批量任务正在其他服务实例运行' })
    }
    batchAvatarJobOwner = req.user.id || req.user.userId
    ownsBatchJob = true
    await logPoolActionRequired(req, {
      action: 'batch_avatar',
      reason: `批量头像同步 account=${accountId || 'all'}`
    })
    const result = await avatarService.batchFetchAvatars(safeBatchSize, null, { accountId })
    res.json({
      success: true,
      message: `批量获取完成: ${result.success} 成功, ${result.skipped} 无头像, ${result.failed} 失败`,
      data: result
    })
  } catch (err) {
    console.error('[Conversations] 批量获取头像失败:', err.message)
    res.status(500).json({ success: false, message: '批量获取头像失败: ' + err.message })
  } finally {
    if (ownsBatchJob) batchAvatarJobOwner = null
    await releaseSharedLease(sharedLease).catch(error => {
      console.error('[Conversations] 释放头像任务租约失败:', error.message)
    })
  }
})

// ========== 拉取单个会话的 WAHA 历史消息 ==========
/**
 * POST /api/v1/conversations/:id/sync-history
 * 从 WAHA 拉取该会话联系人的聊天历史消息
 */
router.post('/:id/sync-history', async (req, res) => {
  try {
    const { id } = req.params
    const { limit, forceUpdate } = req.body
    if (!await requireConversationAccess(req, res, id)) return

    const [convRows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name
       FROM conversations c WHERE c.id = :id`,
      { replacements: { id } }
    )
    if (convRows.length === 0) {
      return res.status(404).json({ success: false, message: '会话不存在' })
    }

    const conv = convRows[0]
    if (conv.channel !== 'whatsapp') {
      return res.status(400).json({ success: false, message: '当前只支持 WhatsApp 历史消息拉取' })
    }

    const waha = await getWahaClientByAccount(conv.account_id)
    if (!waha) {
      return res.status(500).json({ success: false, message: '无可用 WAHA 实例' })
    }

    const chatId = conv.user_id
    const historyLimit = boundedInteger(limit, { fallback: 100, max: 500 })

    console.log(`[SyncHistory] session=${waha.sessionName}, chatId=${chatId}, limit=${historyLimit}`)

    const fetchResult = await fetchWahaChatMessages(waha, chatId, historyLimit, { name: conv.user_name })
    const wahaMessages = fetchResult.messages
    console.log(`[SyncHistory] WAHA 返回 ${wahaMessages.length} 条消息, fetchChatId=${fetchResult.fetchChatId}${fetchResult.usedLidFallback ? ', lidFallback=true' : ''}`)

    if (wahaMessages.length === 0) {
      return res.json({ success: true, data: { imported: 0, skipped: 0, message: '无历史消息' } })
    }

    const standardMessages = wahaMessages
      .map(msg => wahaHistoryMessageToStandard(msg, chatId, conv.account_id))
      .filter(Boolean)
      .sort((a, b) => a.clientTimestamp - b.clientTimestamp)
    await hydrateHistoryMediaMessages(standardMessages, conv.account_id)
    console.log(`[SyncHistory] converted ${standardMessages.length}/${wahaMessages.length} WAHA messages`)
    if (standardMessages.length === 0) {
      console.warn(`[SyncHistory] WAHA returned messages but none were convertible, chatId=${chatId}`, summarizeWahaHistoryMessage(wahaMessages[0]))
    }

    const result = await messagingService.importHistoryMessages(standardMessages, req.eventEmitter, {
      forceUpdate: !!forceUpdate,
      preserveActiveAiSelf: true
    })

    console.log(`[SyncHistory] 导入完成: ${result.imported} 条导入, ${result.updated || 0} 条更新, ${result.skipped} 条跳过`)

    // 同步完成后检测头像 — 无头像则顺便获取（WAHA 连接已就绪）
    let avatarResult = null
    try {
      avatarResult = await avatarService.ensureAvatar(id, conv.account_id, conv.user_id, { force: false })
      if (avatarResult.success) {
        console.log(`[SyncHistory] 头像: ${avatarResult.reason} → ${avatarResult.avatar}`)
      }
    } catch (e) {
      console.warn(`[SyncHistory] 头像获取失败:`, e.message)
    }

    res.json({
      success: true,
      message: `成功导入 ${result.imported} 条历史消息${result.updated > 0 ? `，更新 ${result.updated} 条` : ''}${result.skipped > 0 ? `，跳过 ${result.skipped} 条重复消息` : ''}`,
      data: {
        ...result,
        messagesFetched: wahaMessages.length,
        messagesConverted: standardMessages.length,
        fetchChatId: fetchResult.fetchChatId,
        resolvedChatId: fetchResult.resolvedChatId,
        usedLidFallback: fetchResult.usedLidFallback,
        avatar: avatarResult?.avatar || null,
        avatarUpdated: avatarResult?.success && avatarResult?.reason === '获取成功'
      }
    })
  } catch (err) {
    console.error('[Conversations] 拉取历史消息失败:', err.message)
    res.status(500).json({ success: false, message: '拉取历史消息失败: ' + err.message })
  }
})

// ========== 统一拉取 WhatsApp 历史消息 ==========
/**
 * POST /api/v1/conversations/sync-all-history
 *
 * 从 WAHA 拉取联系人聊天列表和历史消息：
 * 1. 不传 account_id 时，同步所有 active WhatsApp 账号
 * 2. 传 account_id 时，仅同步指定 WhatsApp 账号
 * 3. 对每个账号调用 WAHA GET /api/:session/chats 获取聊天列表
 * 4. 对每个聊天，调用 GET /api/:session/chats/:chatId/messages 拉取消息
 * 5. 批量导入，幂等去重
 *
 * body 参数:
 *   account_id - 可选，指定 WhatsApp 账号 ID（不传则同步所有活跃 WhatsApp 账号）
 *   limit      - 每个聊天拉取多少条消息，默认 100
 */
router.post('/sync-all-history', async (req, res) => {
  let sharedLease = null
  let leaseTransferredToWorker = false
  try {
    if (!['supervisor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '无权执行全量历史同步' })
    }
    const input = req.body || {}
    const body = {
      ...input,
      limit: boundedInteger(input.limit, { fallback: 100, max: 500 })
    }
    const accountId = body.account_id ?? body.accountId ?? null
    if (!await requirePrivilegedAccountScope(req, res, accountId)) return
    if (!enforcePrivilegedActionRateLimit(req, res, 'sync-all-history')) return
    const runningJob = getRunningSyncAllHistoryJob()
    if (runningJob) {
      const canReadRunningJob = req.user.role === 'admin'
        || Number(runningJob.createdBy) === Number(req.user.id || req.user.userId)
        || (req.user.role === 'supervisor'
          && Number(runningJob.scopeAccountId) === Number(accountId)
          && await hasPrivilegedAccountScope(req, runningJob.scopeAccountId))
      return res.json({
        success: true,
        message: '历史同步任务正在运行',
        data: canReadRunningJob ? serializeSyncAllHistoryJob(runningJob) : null
      })
    }

    sharedLease = await acquireSharedLease('conversation-jobs:sync-all-history')
    if (!sharedLease) {
      return res.status(409).json({ success: false, message: '历史同步任务正在其他服务实例运行' })
    }

    const eventEmitter = req.eventEmitter
    await logPoolActionRequired(req, {
      action: 'sync_all_history',
      reason: `历史同步 account=${accountId || 'all'}`
    })
    const job = createSyncAllHistoryJob(req.user)
    job.scopeAccountId = accountId ? Number(accountId) : null
    leaseTransferredToWorker = true
    setImmediate(() => {
      runSyncAllHistoryJob(job, { body, eventEmitter }).catch(err => {
        console.error('[Conversations] 统一拉取历史消息后台任务失败:', err.message, err.stack)
        job.status = 'failed'
        job.finishedAt = new Date().toISOString()
        job.progress.currentAccountId = null
        job.progress.currentChatId = null
        setSyncJobMessage(job, '同步失败: ' + (err.message || JSON.stringify(err)))
      }).finally(() => {
        releaseSharedLease(sharedLease).catch(error => {
          console.error('[Conversations] 释放历史同步任务租约失败:', error.message)
        })
      })
    })

    res.json({
      success: true,
      message: '历史同步任务已在后台开始',
      data: serializeSyncAllHistoryJob(job)
    })
  } catch (err) {
    if (sharedLease && !leaseTransferredToWorker) {
      await releaseSharedLease(sharedLease).catch(() => {})
    }
    console.error('[Conversations] 创建历史同步任务失败:', err.message, err.response?.data, err.stack)
    res.status(500).json({ success: false, message: '创建同步任务失败: ' + (err.message || JSON.stringify(err)) })
  }
})

router.get('/sync-all-history/jobs/:jobId', async (req, res) => {
  const job = syncAllHistoryJobs.get(req.params.jobId)
  const viewerId = req.user.id || req.user.userId
  const canReadOwn = Number(job?.createdBy) === Number(viewerId)
  const canReadAsAdmin = req.user.role === 'admin'
  let canReadAsSupervisor = false
  if (job && req.user.role === 'supervisor' && job.scopeAccountId) {
    canReadAsSupervisor = await hasPrivilegedAccountScope(req, job.scopeAccountId)
  }
  if (!job || (!canReadOwn && !canReadAsAdmin && !canReadAsSupervisor)) {
    return res.status(404).json({ success: false, message: '同步任务不存在或已过期' })
  }
  res.json({ success: true, data: serializeSyncAllHistoryJob(job) })
})

// ========== 抢单 ==========
/**
 * POST /api/v1/conversations/:id/claim
 * 坐席认领会话（从 AI自助池/待人工池/公共池 → 私有池）
 */
router.post('/:id/claim', async (req, res) => {
  try {
    const { id } = req.params
    const currentUserId = req.user.id || req.user.userId
    const currentUserName = req.user.username || `坐席${currentUserId}`
    const requestedSeatId = req.body?.seat_id ? Number(req.body.seat_id) : null
    if (!await requireConversationAccess(req, res, id)) return

    let seatId = currentUserId
    let seatName = currentUserName
    const claimOptions = {}

    if (requestedSeatId) {
      if (!Number.isInteger(requestedSeatId) || requestedSeatId <= 0) {
        return res.status(400).json({ success: false, message: '无效的目标坐席' })
      }
      if (!['admin', 'supervisor'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: '无权分配坐席' })
      }

      const targetAgent = await findActiveAgent(requestedSeatId, id)
      if (!targetAgent) {
        return res.status(400).json({ success: false, message: '目标坐席不存在或不可用' })
      }

      seatId = targetAgent.id
      seatName = targetAgent.username || `坐席${seatId}`
      claimOptions.operatorId = currentUserId
      claimOptions.operatorName = currentUserName
      claimOptions.operatorType = req.user.role
      claimOptions.reason = `管理员分配给坐席：${seatName}`
      claimOptions.successMessage = '分配成功'
    } else if (req.user.role === 'admin') {
      return res.status(400).json({ success: false, message: '管理员请先选择要分配的坐席' })
    }

    const result = await poolService.claimConversation(id, seatId, seatName, req.eventEmitter, claimOptions)

    if (result.success) {
      res.json({ success: true, message: result.message || '抢单成功', data: result })
    } else {
      res.status(400).json({ success: false, message: result.message, data: result.capacity })
    }
  } catch (err) {
    console.error('[Conversations] 抢单失败:', err.message)
    res.status(500).json({ success: false, message: '抢单失败: ' + err.message })
  }
})

// ========== 释放会话 ==========
/**
 * POST /api/v1/conversations/:id/release
 * 坐席释放会话回公共池
 */
router.post('/:id/release', async (req, res) => {
  try {
    const { id } = req.params
    const seatId = req.user.id || req.user.userId
    const seatName = req.user.username || `坐席${seatId}`
    if (!await requireConversationAccess(req, res, id)) return

    const result = await poolService.releaseConversation(id, seatId, seatName, req.eventEmitter)

    if (result.success) {
      res.json({ success: true, message: '释放成功', data: result })
    } else {
      res.status(400).json({ success: false, message: result.message })
    }
  } catch (err) {
    console.error('[Conversations] 释放会话失败:', err.message)
    res.status(500).json({ success: false, message: '释放失败: ' + err.message })
  }
})

// ========== 标记长期跟进 ==========
/**
 * POST /api/v1/conversations/:id/mark-long-term
 * 将会话标记为长期跟进
 */
router.post('/:id/mark-long-term', async (req, res) => {
  try {
    const { id } = req.params
    const seatId = req.user.id || req.user.userId
    const seatName = req.user.username || `坐席${seatId}`
    const { bind_seat_id } = req.body
    if (!await requireConversationAccess(req, res, id)) return

    // 管理员可以指定绑定坐席；其他角色默认绑定操作者
    const bindSeatId = (req.user.role === 'admin' || req.user.role === 'supervisor') && bind_seat_id
      ? bind_seat_id
      : seatId

    const result = await poolService.markLongTerm(id, seatId, seatName, req.eventEmitter, bindSeatId)

    if (result.success) {
      res.json({ success: true, message: '已标记为长期跟进', data: result })
    } else {
      res.status(400).json({ success: false, message: result.message })
    }
  } catch (err) {
    console.error('[Conversations] 标记长期跟进失败:', err.message)
    res.status(500).json({ success: false, message: '标记失败: ' + err.message })
  }
})

// ========== 归档会话 ==========
/**
 * POST /api/v1/conversations/:id/archive
 * 归档会话（结束处理）
 */
router.post('/:id/archive', async (req, res) => {
  try {
    const { id } = req.params
    const seatId = req.user.id || req.user.userId
    const seatName = req.user.username || `坐席${seatId}`
    if (!await requireConversationAccess(req, res, id)) return

    const result = await poolService.archiveConversation(id, seatId, seatName, req.eventEmitter)

    if (result.success) {
      res.json({ success: true, message: '会话已归档', data: result })
    } else {
      res.status(400).json({ success: false, message: result.message })
    }
  } catch (err) {
    console.error('[Conversations] 归档失败:', err.message)
    res.status(500).json({ success: false, message: '归档失败: ' + err.message })
  }
})

// ========== 复活归档会话 ==========
/**
 * POST /api/v1/conversations/:id/revive
 * 复活归档会话（从归档 → 待人工池）
 * 用于坐席手动复活已归档的会话
 */
router.post('/:id/revive', async (req, res) => {
  try {
    const { id } = req.params
    const seatId = req.user.id || req.user.userId
    const seatName = req.user.username || `坐席${seatId}`
    if (!await requireConversationAccess(req, res, id)) return

    const result = await poolService.reviveConversation(id, seatId, seatName, req.eventEmitter)

    if (result.success) {
      res.json({ success: true, message: '会话已复活到待人工池', data: result })
    } else {
      res.status(400).json({ success: false, message: result.message })
    }
  } catch (err) {
    console.error('[Conversations] 复活失败:', err.message)
    res.status(500).json({ success: false, message: '复活失败: ' + err.message })
  }
})

// ========== 手动转 AI 自助池 ==========
/**
 * POST /api/v1/conversations/:id/transfer-to-ai
 * 坐席手动将会话转入 AI 自助池，并基于最近一条客户入站消息触发 AI 回复
 */
router.post('/:id/transfer-to-ai', async (req, res) => {
  try {
    const { id } = req.params
    const seatId = req.user.id || req.user.userId
    const seatName = req.user.username || `坐席${seatId}`
    if (!await requireConversationAccess(req, res, id)) return

    const aiEnabled = await configService.getConfig('ai_self_pool_enabled', true)
    if (aiEnabled === false) {
      return res.status(400).json({ success: false, message: 'AI自助聊天总开关已关闭，不能手动转入 AI 自助池' })
    }

    const result = await poolService.transferToAiSelf(id, seatId, seatName, req.eventEmitter)
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message })
    }

    let queueResult = { queued: false }
    try {
      const latestMessage = await getLatestInboundCustomerMessage(id)
      queueResult = await enqueueManualAiReply(id, latestMessage, req.eventEmitter)
    } catch (queueErr) {
      console.error('[Conversations] 手动转 AI 后入队失败:', queueErr.message)
      queueResult = { queued: false, reason: 'AI回复任务入队失败: ' + queueErr.message }
    }

    res.json({
      success: true,
      message: queueResult.queued ? '已转入 AI 自助池' : '已转入 AI 自助池，但未触发自动回复',
      data: { ...result, aiReplyQueued: queueResult.queued, queueReason: queueResult.reason || '' }
    })
  } catch (err) {
    console.error('[Conversations] 手动转 AI 自助池失败:', err.message)
    res.status(500).json({ success: false, message: '转 AI 自助池失败: ' + err.message })
  }
})

// ========== 转交会话 ==========
/**
 * POST /api/v1/conversations/:id/transfer
 * 转交会话给其他坐席（supervisor/admin 权限）
 */
router.post('/:id/transfer', async (req, res) => {
  try {
    if (!['supervisor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '无权限转交会话' })
    }

    const { id } = req.params
    const { to_seat_id } = req.body
    const fromSeatId = req.user.id || req.user.userId
    const fromSeatName = req.user.username || `管理员${fromSeatId}`

    if (!to_seat_id) {
      return res.status(400).json({ success: false, message: 'to_seat_id 不能为空' })
    }
    if (!await requireConversationAccess(req, res, id)) return

    const targetUser = await findActiveAgent(to_seat_id, id)
    if (!targetUser) {
      return res.status(400).json({ success: false, message: '目标客服不存在或不可用' })
    }
    const toSeatName = targetUser.username

    const result = await poolService.transferConversation(
      id, fromSeatId, fromSeatName,
      parseInt(to_seat_id), toSeatName,
      req.eventEmitter
    )

    if (result.success) {
      res.json({ success: true, message: '转交成功', data: result })
    } else {
      res.status(400).json({ success: false, message: result.message })
    }
  } catch (err) {
    console.error('[Conversations] 转交失败:', err.message)
    res.status(500).json({ success: false, message: '转交失败: ' + err.message })
  }
})

module.exports = router
