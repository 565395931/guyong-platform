/**
 * 会话池驱动服务 - 核心业务逻辑
 *
 * 职责：
 * 1. 新消息入池路由：根据会话当前池类型和上下文决定消息进入哪个池
 * 2. 抢单(claim)：坐席认领会话，转入私有池
 * 3. 释放(release)：坐席释放会话回公共池
 * 4. 标记长期(markLongTerm)：将会话移入长期跟进池
 * 5. 归档(archive)：结束会话
 * 6. 转交(transfer)：将会话转给其他坐席
 * 7. 手动转 AI：将会话交回 AI 自助池
 * 8. 坐席负载均衡：检查并发上限
 * 9. 操作日志记录
 * 10. 坐席在线状态管理
 * 11. 坐席离线自动释放
 *
 * 架构约束：
 * - 所有池切换操作都通过本模块，确保日志记录完整
 * - 抢单使用乐观锁（WHERE pool_type != 'private'）防止并发冲突
 * - 不直接操作 Socket.IO，通过 eventEmitter 发事件给 pushService
 */

const { sequelize } = require('../../config/database')
const { INTERNAL_EVENTS } = require('../websocket/events')
const { removePendingAiReplyJobs } = require('../../queues')
const {
  matchCustomerHandoffKeyword,
  buildCustomerHandoffReason,
  extractMessageText
} = require('./handoff-keyword.service')
const {
  POOL_TYPE,
  CONV_STATUS,
  POOL_STATUS_MAP,
  POOL_ACTION,
  LAST_REPLY_BY,
  SEAT_STATUS
} = require('./constants')
const systemLogger = require('../../utils/systemLogger')
const { getDispatcher } = require('../cloud-gateway/runtime')

// 延迟加载 User / Messaging / 渠道适配器，避免循环依赖
let User = null
let messagingService = null
let getAdapterByChannel = null
const POOL_STATS_CACHE_TTL_MS = 2000
const poolStatsCache = new Map()

function getPoolStatsCacheKey(seatId, role) {
  return `${role || 'guest'}:${seatId || 'all'}`
}

function clearPoolStatsCache() {
  poolStatsCache.clear()
}

function getUserModel() {
  if (!User) {
    User = require('../../models/User')
  }
  return User
}

function getMessagingService() {
  if (!messagingService) {
    messagingService = require('../messaging/messaging.service')
  }
  return messagingService
}

function getChannelAdapterByChannel(channel) {
  if (!getAdapterByChannel) {
    ({ getAdapterByChannel } = require('../channel-adapters'))
  }
  return getAdapterByChannel(channel)
}

function normalizePositiveInt(value, fallback = 5) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function normalizeNonNegativeInt(value, fallback = 5) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return fallback
  return Math.floor(num)
}

async function getUserMaxConcurrent(userId) {
  const UserModel = getUserModel()
  const user = await UserModel.findByPk(userId, { attributes: ['id', 'maxConcurrent'] })
  return normalizePositiveInt(user?.maxConcurrent, 5)
}

async function getGlobalSeatMaxConcurrent() {
  try {
    const configService = require('../../services/configService')
    const value = await configService.getConfig('seat_max_concurrent', 5)
    return normalizeNonNegativeInt(value, 5)
  } catch (err) {
    console.error('[PoolService] read seat_max_concurrent failed:', err.message)
    return 5
  }
}

const DEFAULT_AFTER_HOURS_TRANSFER_NOTICE = '现在是非工作时间段，我手头没有资料，等工作时间再跟您详聊。'

function normalizeTimeString(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,2}:\d{2}$/.test(raw)) return fallback

  const [hourText, minuteText] = raw.split(':')
  const hour = parseInt(hourText, 10)
  const minute = parseInt(minuteText, 10)
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function timeStringToMinutes(value) {
  const [hourText, minuteText] = value.split(':')
  return parseInt(hourText, 10) * 60 + parseInt(minuteText, 10)
}

function getCurrentChinaMinutes() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date())

  const hour = parseInt(parts.find(part => part.type === 'hour')?.value || '0', 10)
  const minute = parseInt(parts.find(part => part.type === 'minute')?.value || '0', 10)
  return hour * 60 + minute
}

function isWithinBusinessHours(startTime, endTime) {
  const startMinutes = timeStringToMinutes(startTime)
  const endMinutes = timeStringToMinutes(endTime)
  const currentMinutes = getCurrentChinaMinutes()

  if (startMinutes === endMinutes) return true
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

function languageLabelFromCode(code) {
  const labels = {
    zh: '中文',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    ko: 'Korean',
    ar: 'Arabic',
    ru: 'Russian',
    pt: 'Portuguese',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    tr: 'Turkish',
    it: 'Italian'
  }
  return labels[code] || code || '客户消息的原语言'
}

function looksChinese(text) {
  if (!text) return false
  const compactText = String(text).replace(/\s/g, '')
  if (!compactText) return false
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  return cjkCount / compactText.length >= 0.3
}

function normalizeCustomerLanguageInfo(customerLanguage) {
  if (!customerLanguage) return null

  if (typeof customerLanguage === 'string') {
    if (customerLanguage === 'zh') {
      return { group: 'zh', code: 'zh', label: '中文' }
    }
    return { group: 'other', code: customerLanguage, label: languageLabelFromCode(customerLanguage) }
  }

  const code = customerLanguage.code || (customerLanguage.group === 'other' ? 'other' : 'zh')
  const group = customerLanguage.group === 'other' || (code && code !== 'zh') ? 'other' : 'zh'
  return {
    group,
    code,
    label: customerLanguage.label || languageLabelFromCode(code)
  }
}

function detectLanguageHeuristically(text) {
  if (!text) return { group: 'zh', code: 'zh', label: '中文' }

  const compactText = String(text).replace(/\s/g, '')
  const cjkCount = (compactText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  if (compactText.length > 0 && cjkCount / compactText.length >= 0.3) {
    return { group: 'zh', code: 'zh', label: '中文' }
  }

  const code = /[a-zA-Z]{3,}/.test(text) ? 'en' : 'other'
  return { group: 'other', code, label: languageLabelFromCode(code) }
}

// ========== 坐席在线状态管理 ==========

/**
 * 更新坐席在线状态
 * @param {number} userId - 坐席用户 ID
 * @param {string} status - online/offline/away/busy
 */
async function updateSeatStatus(userId, status) {
  try {
    // 查询 users 表的 max_concurrent
    const maxConcurrent = await getUserMaxConcurrent(userId)

    await sequelize.query(
      `INSERT INTO seat_status (user_id, status, last_active_at, max_concurrent, updated_at)
       VALUES (:userId, :status, NOW(), :maxConcurrent, NOW())
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         last_active_at = VALUES(last_active_at),
         max_concurrent = VALUES(max_concurrent),
         updated_at = NOW()`,
      { replacements: { userId, status, maxConcurrent } }
    )
  } catch (err) {
    console.error('[PoolService] 更新坐席状态失败:', err.message)
  }
}

async function syncSeatMaxConcurrent(userId, maxConcurrent) {
  try {
    const normalizedMaxConcurrent = normalizePositiveInt(maxConcurrent, 5)
    await sequelize.query(
      `UPDATE seat_status
       SET max_concurrent = :maxConcurrent, updated_at = NOW()
       WHERE user_id = :userId`,
      { replacements: { userId, maxConcurrent: normalizedMaxConcurrent } }
    )
  } catch (err) {
    console.error('[PoolService] sync seat max_concurrent failed:', err.message)
  }
}

/**
 * 获取坐席当前并发接待数
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function getSeatLoad(userId) {
  try {
    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM conversations
       WHERE claimed_by = :userId AND pool_type = :poolType`,
      { replacements: { userId, poolType: POOL_TYPE.PRIVATE } }
    )
    return rows[0]?.cnt || 0
  } catch (err) {
    console.error('[PoolService] 获取坐席负载失败:', err.message)
    return 0
  }
}

/**
 * 获取坐席最大并发数
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function getSeatMaxConcurrent(userId) {
  try {
    const globalMaxConcurrent = await getGlobalSeatMaxConcurrent()
    // Keep the historical default behavior: 5 means "no explicit global override".
    if (globalMaxConcurrent > 0 && globalMaxConcurrent !== 5) {
      return globalMaxConcurrent
    }

    // Always use users.max_concurrent as the per-seat source of truth; seat_status can lag behind.
    return await getUserMaxConcurrent(userId)
  } catch (err) {
    console.error('[PoolService] 获取坐席最大并发失败:', err.message)
    return 5
  }
}

/**
 * 检查坐席是否可认领更多会话
 * @param {number} userId
 * @returns {Promise<{canClaim: boolean, current: number, max: number}>}
 */
async function checkSeatCapacity(userId) {
  const current = await getSeatLoad(userId)
  const max = await getSeatMaxConcurrent(userId)
  return { canClaim: current < max, current, max }
}

function normalizeBooleanConfig(value, fallback = true) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  }
  return fallback
}

async function isSeatOfflineReleaseEnabled() {
  try {
    const configService = require('../../services/configService')
    const value = await configService.getConfig('seat_offline_release', true)
    return normalizeBooleanConfig(value, true)
  } catch (err) {
    console.error('[PoolService] 读取坐席离线自动释放配置失败:', err.message)
    return true
  }
}

// ========== 坐席离线自动释放 ==========

/**
 * 坐席离线时自动释放私有池会话回公共池
 * @param {number} userId
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<number>} 释放的会话数
 */
async function releaseOnSeatOffline(userId, eventEmitter) {
  try {
    // 获取坐席名
    const UserModel = getUserModel()
    const user = await UserModel.findByPk(userId, { attributes: ['id', 'username'] })
    if (!await isSeatOfflineReleaseEnabled()) {
      const disabledOperatorName = user?.username || `user${userId}`
      await updateSeatStatus(userId, SEAT_STATUS.OFFLINE)
      console.log(`[PoolService] seat_offline_release is disabled, skip auto release for seat ${disabledOperatorName}`)
      return 0
    }
    const operatorName = user?.username || `用户${userId}`

    // 查询该坐席所有私有池会话
    const [conversations] = await sequelize.query(
      `SELECT id FROM conversations
       WHERE claimed_by = :userId AND pool_type = :poolType`,
      { replacements: { userId, poolType: POOL_TYPE.PRIVATE } }
    )

    let releasedCount = 0
    for (const conv of conversations) {
      const result = await movePool({
        conversationId: conv.id,
        targetPool: POOL_TYPE.PUBLIC,
        operatorId: userId,
        operatorName,
        operatorType: 'system',
        reason: '坐席离线自动释放',
        eventEmitter
      })
      if (result.success) {
        await logPoolAction({
          conversationId: conv.id,
          action: POOL_ACTION.SEAT_OFFLINE_RELEASE,
          fromPool: POOL_TYPE.PRIVATE,
          toPool: POOL_TYPE.PUBLIC,
          operatorId: userId,
          operatorName,
          operatorType: 'system',
          reason: '坐席离线自动释放'
        })
        releasedCount++
      }
    }

    // 更新坐席状态为离线
    await updateSeatStatus(userId, SEAT_STATUS.OFFLINE)

    if (releasedCount > 0) {
      console.log(`[PoolService] 坐席 ${operatorName} 离线，自动释放 ${releasedCount} 个会话`)
    }

    return releasedCount
  } catch (err) {
    console.error('[PoolService] 坐席离线释放失败:', err.message)
    return 0
  }
}

// ========== 核心池切换 ==========

/**
 * 统一的池切换函数（内部使用）
 *
 * 使用乐观锁防止并发冲突：
 * 只有当会话当前池类型不是 targetPool 时才更新
 *
 * @param {Object} params
 * @param {string} params.conversationId - 会话 ID
 * @param {string} params.targetPool - 目标池类型
 * @param {number|null} params.operatorId - 操作人 ID
 * @param {string} params.operatorName - 操作人名称
 * @param {string} params.operatorType - agent/ai/system/admin
 * @param {string} params.reason - 操作原因
 * @param {number|null} params.claimedBy - 认领坐席 ID（抢单/转交时用）
 * @param {EventEmitter} params.eventEmitter
 * @returns {Promise<{success: boolean, message: string, conversation?: Object}>}
 */
async function movePool(params) {
  const {
    conversationId,
    targetPool,
    operatorId = null,
    operatorName = '',
    operatorType = 'system',
    reason = '',
    claimedBy = null,
    eventEmitter
  } = params

  try {
    // 查询当前会话状态
    const [rows] = await sequelize.query(
      `SELECT id, pool_type, conv_status, claimed_by FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { success: false, message: '会话不存在' }
    }

    const conv = rows[0]
    const fromPool = conv.pool_type

    // 已经在目标池，无需切换
    if (fromPool === targetPool && (targetPool !== POOL_TYPE.PRIVATE || conv.claimed_by === claimedBy)) {
      return { success: false, message: '会话已在目标池中' }
    }

    // 乐观锁更新：只有当前池类型匹配时才更新（防止并发抢单冲突）
    const targetStatus = POOL_STATUS_MAP[targetPool] || CONV_STATUS.PENDING_CLAIM
    let updateSql, updateReplacements

    if (targetPool === POOL_TYPE.PRIVATE) {
      // 抢单/转交 → 私有池
      updateSql = `UPDATE conversations
                   SET pool_type = :targetPool, conv_status = :targetStatus,
                       claimed_by = :claimedBy, claimed_at = NOW(),
                       updated_at = NOW()
                   WHERE id = :conversationId AND pool_type != :targetPool`
      updateReplacements = { targetPool, targetStatus, claimedBy, conversationId }
    } else if (targetPool === POOL_TYPE.PUBLIC || targetPool === POOL_TYPE.PENDING_HUMAN) {
      // 释放/转人工 → 公共池/待人工池，清除认领信息
      updateSql = `UPDATE conversations
                   SET pool_type = :targetPool, conv_status = :targetStatus,
                       claimed_by = NULL, claimed_at = NULL,
                       updated_at = NOW()
                   WHERE id = :conversationId`
      updateReplacements = { targetPool, targetStatus, conversationId }
    } else if (targetPool === POOL_TYPE.LONG_TERM) {
      // 标记长期
      updateSql = `UPDATE conversations
                   SET pool_type = :targetPool, conv_status = :targetStatus,
                       updated_at = NOW()
                   WHERE id = :conversationId`
      updateReplacements = { targetPool, targetStatus, conversationId }
    } else if (targetPool === POOL_TYPE.AI_SELF) {
      // 回到 AI 自助池
      updateSql = `UPDATE conversations
                   SET pool_type = :targetPool, conv_status = :targetStatus,
                       claimed_by = NULL, claimed_at = NULL,
                       updated_at = NOW()
                   WHERE id = :conversationId`
      updateReplacements = { targetPool, targetStatus, conversationId }
    } else {
      updateSql = `UPDATE conversations
                   SET pool_type = :targetPool, conv_status = :targetStatus,
                       updated_at = NOW()
                   WHERE id = :conversationId`
      updateReplacements = { targetPool, targetStatus, conversationId }
    }

    const [result] = await sequelize.query(updateSql, { replacements: updateReplacements })

    // 检查是否更新成功（affected rows）
    if (result.affectedRows === 0) {
      // 可能是并发冲突：别人已经抢单了
      return { success: false, message: '会话状态已变更，请刷新后重试（可能已被其他坐席认领）' }
    }
    clearPoolStatsCache()

    // 记录操作日志
    await logPoolAction({
      conversationId,
      action: POOL_ACTION.POOL_CHANGE,
      fromPool,
      toPool: targetPool,
      operatorId,
      operatorName,
      operatorType,
      reason
    })

    // 查询更新后的完整会话信息
    const [updatedRows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.agent_id,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at,
              u.username AS agent_name,
              u.username AS claimed_by_name
       FROM conversations c
       LEFT JOIN users u ON c.claimed_by = u.id
       WHERE c.id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    const updatedConv = updatedRows[0] || null

    // 会话离开 AI 自助池后，清理尚未开始执行的 AI 自动回复残留任务。
    // 已经 active 的任务不能从 BullMQ 安全删除，会在 Worker/发送前再次校验池状态并跳过。
    if (fromPool === POOL_TYPE.AI_SELF && targetPool !== POOL_TYPE.AI_SELF) {
      await removePendingAiReplyJobs(conversationId, `池流转 ${fromPool} -> ${targetPool}`)
    }

    // 发射池变更事件 → pushService 推送前端
    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: conversationId,
        conversationId,
        type: 'pool_change',
        fromPool,
        toPool: targetPool,
        operatorId,
        operatorType,
        reason,
        conversation: updatedConv
      })
    }

    return { success: true, message: '池切换成功', conversation: updatedConv }
  } catch (err) {
    console.error('[PoolService] 池切换失败:', err.message)
    return { success: false, message: '池切换失败: ' + err.message }
  }
}

// ========== 公共 API：抢单 ==========

/**
 * 坐席抢单（认领会话）
 *
 * 从 AI自助池/待人工池/公共池 → 私有池
 * 使用乐观锁防止多人同时抢单
 *
 * @param {string} conversationId
 * @param {number} seatId - 坐席用户 ID
 * @param {string} seatName
 * @param {EventEmitter} eventEmitter
 * @param {object} options
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function claimConversation(conversationId, seatId, seatName, eventEmitter, options = {}) {
  const operatorId = options.operatorId || seatId
  const operatorName = options.operatorName || seatName
  const operatorType = options.operatorType || 'agent'
  const reason = options.reason || '坐席抢单'
  const successMessage = options.successMessage || '抢单成功'

  // 1. 检查坐席负载
  const capacity = await checkSeatCapacity(seatId)
  if (!capacity.canClaim) {
    return {
      success: false,
      message: `已达接待上限（${capacity.current}/${capacity.max}），请先释放部分会话`,
      capacity
    }
  }

  // 2. 查询当前池类型（用于日志记录）
  const [preRows] = await sequelize.query(
    `SELECT pool_type FROM conversations WHERE id = :conversationId LIMIT 1`,
    { replacements: { conversationId } }
  )
  if (preRows.length === 0) {
    return { success: false, message: '会话不存在' }
  }
  const fromPoolType = preRows[0].pool_type || null

  // 3. 乐观锁抢单：只有当会话不在 private 池时才能抢单
  try {
    const [result] = await sequelize.query(
      `UPDATE conversations
       SET pool_type = :privatePool, conv_status = :handlingStatus,
           agent_id = :seatId,
           claimed_by = :seatId, claimed_at = NOW(),
           updated_at = NOW()
       WHERE id = :conversationId AND pool_type != :privatePool`,
      {
        replacements: {
          privatePool: POOL_TYPE.PRIVATE,
          handlingStatus: CONV_STATUS.HANDLING,
          seatId,
          conversationId
        }
      }
    )

    if (result.affectedRows === 0) {
      // 检查是否已被认领
      const [rows] = await sequelize.query(
        `SELECT pool_type, claimed_by FROM conversations WHERE id = :conversationId LIMIT 1`,
        { replacements: { conversationId } }
      )
      if (rows.length === 0) {
        return { success: false, message: '会话不存在' }
      }
      if (rows[0].pool_type === POOL_TYPE.PRIVATE) {
        return { success: false, message: '该会话已被其他坐席认领' }
      }
      return { success: false, message: '抢单失败，请刷新后重试' }
    }
    clearPoolStatsCache()

    // 3. 记录日志
    await logPoolAction({
      conversationId,
      action: POOL_ACTION.CLAIM,
      fromPool: fromPoolType,
      toPool: POOL_TYPE.PRIVATE,
      operatorId,
      operatorName,
      operatorType,
      reason
    })

    // 4. 查询更新后的会话信息
    const [updatedRows] = await sequelize.query(
      `SELECT c.id, c.channel, c.account_id, c.user_id, c.user_name, c.agent_id,
              c.pool_type, c.conv_status, c.claimed_by, c.claimed_at, c.priority,
              c.last_reply_by, c.last_reply_time,
              c.last_message, c.last_message_time, c.unread_count, c.status, c.created_at,
              u.username AS agent_name
       FROM conversations c
       LEFT JOIN users u ON c.claimed_by = u.id
       WHERE c.id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    const updatedConv = updatedRows[0] || null

    // 5. 发射事件
    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: conversationId,
        conversationId,
        type: 'claimed',
        operatorId,
        conversation: updatedConv
      })
    }

    // 6. 更新坐席在线状态
    await updateSeatStatus(seatId, SEAT_STATUS.ONLINE)

    return { success: true, message: successMessage, conversation: updatedConv, capacity }
  } catch (err) {
    console.error('[PoolService] 抢单失败:', err.message)
    return { success: false, message: '抢单失败: ' + err.message }
  }
}

/**
 * 客服直接回复前确保会话归属。
 *
 * 公共/待人工/AI 池直接回复时，自动认领到当前客服私有池。
 * 本人长期跟进池直接回复时保持在长期跟进池，不转私有池。
 * 已归档会话不自动复活；已被其他客服私有/长期跟进的会话不静默抢走。
 */
async function ensureClaimedForReply(conversationId, seatId, seatName, eventEmitter) {
  const [rows] = await sequelize.query(
    `SELECT id, pool_type, conv_status, claimed_by
     FROM conversations
     WHERE id = :conversationId
     LIMIT 1`,
    { replacements: { conversationId } }
  )

  if (rows.length === 0) {
    return { success: false, message: '会话不存在' }
  }

  const conv = rows[0]
  if (conv.conv_status === CONV_STATUS.ARCHIVED) {
    return { success: false, message: '会话已归档，请先复活后再回复' }
  }

  if (conv.pool_type === POOL_TYPE.PRIVATE) {
    if (!conv.claimed_by || Number(conv.claimed_by) === Number(seatId)) {
      return { success: true, unchanged: true }
    }
    return { success: false, message: '该会话已被其他客服认领，请先转交或释放后再回复' }
  }

  if (conv.pool_type === POOL_TYPE.LONG_TERM) {
    if (conv.claimed_by && Number(conv.claimed_by) !== Number(seatId)) {
      return { success: false, message: '该长期跟进会话属于其他客服，请先转交后再回复' }
    }
    return { success: true, unchanged: true }
  }

  return claimConversation(conversationId, seatId, seatName, eventEmitter)
}

// ========== 公共 API：释放 ==========

/**
 * 坐席释放会话回公共池
 *
 * 从 私有池/长期跟进池 → 公共池
 *
 * @param {string} conversationId
 * @param {number} seatId - 必须是当前认领的坐席
 * @param {string} seatName
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function releaseConversation(conversationId, seatId, seatName, eventEmitter) {
  try {
    // 检查是否是当前坐席认领的
    const [rows] = await sequelize.query(
      `SELECT pool_type, claimed_by FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { success: false, message: '会话不存在' }
    }

    const fromPool = rows[0].pool_type
    if (![POOL_TYPE.PRIVATE, POOL_TYPE.LONG_TERM].includes(fromPool)) {
      return { success: false, message: '只有私有池或长期跟进池会话可以释放' }
    }

    if (rows[0].claimed_by !== seatId) {
      return { success: false, message: '只能释放自己认领的会话' }
    }

    const result = await movePool({
      conversationId,
      targetPool: POOL_TYPE.PUBLIC,
      operatorId: seatId,
      operatorName: seatName,
      operatorType: 'agent',
      reason: '坐席主动释放',
      eventEmitter
    })

    if (result.success) {
      // 额外记录 release action 日志
      await logPoolAction({
        conversationId,
        action: POOL_ACTION.RELEASE,
        fromPool,
        toPool: POOL_TYPE.PUBLIC,
        operatorId: seatId,
        operatorName: seatName,
        operatorType: 'agent',
        reason: '坐席主动释放'
      })
    }

    return result
  } catch (err) {
    console.error('[PoolService] 释放会话失败:', err.message)
    return { success: false, message: '释放失败: ' + err.message }
  }
}

// ========== 公共 API：标记长期跟进 ==========

/**
 * 标记会话为长期跟进
 *
 * 从 私有池 → 长期跟进池
 *
 * @param {string} conversationId
 * @param {number} seatId
 * @param {string} seatName
 * @param {EventEmitter} eventEmitter
 * @param {number|null} bindSeatId - 绑定的固定坐席（可选，管理员可指定）
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function markLongTerm(conversationId, seatId, seatName, eventEmitter, bindSeatId = null) {
  try {
    const result = await movePool({
      conversationId,
      targetPool: POOL_TYPE.LONG_TERM,
      operatorId: seatId,
      operatorName: seatName,
      operatorType: 'agent',
      reason: '标记长期跟进',
      eventEmitter
    })

    if (result.success) {
      // 如果指定了绑定坐席，更新 claimed_by
      if (bindSeatId) {
        await sequelize.query(
          `UPDATE conversations SET claimed_by = :bindSeatId WHERE id = :conversationId`,
          { replacements: { bindSeatId, conversationId } }
        )
        clearPoolStatsCache()
      }

      await logPoolAction({
        conversationId,
        action: POOL_ACTION.MARK_LONG_TERM,
        fromPool: POOL_TYPE.PRIVATE,
        toPool: POOL_TYPE.LONG_TERM,
        operatorId: seatId,
        operatorName: seatName,
        operatorType: 'agent',
        reason: '标记长期跟进'
      })
    }

    return result
  } catch (err) {
    console.error('[PoolService] 标记长期跟进失败:', err.message)
    return { success: false, message: '标记失败: ' + err.message }
  }
}

// ========== 公共 API：归档 ==========

/**
 * 归档会话（结束处理）
 *
 * @param {string} conversationId
 * @param {number} seatId
 * @param {string} seatName
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function archiveConversation(conversationId, seatId, seatName, eventEmitter) {
  try {
    // 查询当前池类型（用于日志记录）
    const [preRows] = await sequelize.query(
      `SELECT pool_type FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )
    const fromPoolType = preRows[0]?.pool_type || null

    await sequelize.query(
      `UPDATE conversations
       SET conv_status = :archived, status = 'closed', updated_at = NOW()
       WHERE id = :conversationId`,
      { replacements: { archived: CONV_STATUS.ARCHIVED, conversationId } }
    )
    clearPoolStatsCache()

    await logPoolAction({
      conversationId,
      action: POOL_ACTION.ARCHIVE,
      fromPool: fromPoolType,
      toPool: null,
      operatorId: seatId,
      operatorName: seatName,
      operatorType: 'agent',
      reason: '坐席归档会话'
    })

    if (eventEmitter) {
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: conversationId,
        conversationId,
        type: 'archived',
        operatorId: seatId
      })
    }

    return { success: true, message: '会话已归档' }
  } catch (err) {
    console.error('[PoolService] 归档失败:', err.message)
    return { success: false, message: '归档失败: ' + err.message }
  }
}

// ========== 公共 API：转交 ==========

/**
 * 转交会话给其他坐席
 *
 * @param {string} conversationId
 * @param {number} fromSeatId - 原坐席 ID
 * @param {string} fromSeatName
 * @param {number} toSeatId - 目标坐席 ID
 * @param {string} toSeatName
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function transferConversation(conversationId, fromSeatId, fromSeatName, toSeatId, toSeatName, eventEmitter) {
  try {
    // 检查目标坐席负载
    const capacity = await checkSeatCapacity(toSeatId)
    if (!capacity.canClaim) {
      return {
        success: false,
        message: `目标坐席已达接待上限（${capacity.current}/${capacity.max}）`,
        capacity
      }
    }

    // 直接更新为私有池，claimed_by 改为目标坐席
    const [result] = await sequelize.query(
      `UPDATE conversations
       SET pool_type = :privatePool, conv_status = :handlingStatus,
           claimed_by = :toSeatId, claimed_at = NOW(),
           updated_at = NOW()
       WHERE id = :conversationId AND claimed_by = :fromSeatId`,
      {
        replacements: {
          privatePool: POOL_TYPE.PRIVATE,
          handlingStatus: CONV_STATUS.HANDLING,
          toSeatId,
          conversationId,
          fromSeatId
        }
      }
    )

    if (result.affectedRows === 0) {
      return { success: false, message: '转交失败：会话可能已被释放或认领' }
    }
    clearPoolStatsCache()

    await logPoolAction({
      conversationId,
      action: POOL_ACTION.TRANSFER,
      fromPool: POOL_TYPE.PRIVATE,
      toPool: POOL_TYPE.PRIVATE,
      operatorId: fromSeatId,
      operatorName: fromSeatName,
      operatorType: 'admin',
      reason: `转交给 ${toSeatName}`
    })

    if (eventEmitter) {
      // 通知原坐席
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: conversationId,
        conversationId,
        type: 'transferred_out',
        operatorId: fromSeatId,
        previousAgentId: fromSeatId,
        conversation: null
      })
      // 通知新坐席
      eventEmitter.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: conversationId,
        conversationId,
        type: 'transferred_in',
        operatorId: toSeatId,
        conversation: null
      })
    }

    return { success: true, message: '转交成功', capacity }
  } catch (err) {
    console.error('[PoolService] 转交失败:', err.message)
    return { success: false, message: '转交失败: ' + err.message }
  }
}

// ========== 公共 API：手动转 AI 自助池 ==========

/**
 * 坐席手动将会话转回 AI 自助池。
 *
 * 从 待人工池/公共池/私有池/长期跟进池 → AI 自助池
 * 已归档或已在 AI 自助池的会话不处理。
 */
async function transferToAiSelf(conversationId, operatorId, operatorName, eventEmitter) {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, pool_type, conv_status, claimed_by
       FROM conversations
       WHERE id = :conversationId
       LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { success: false, message: '会话不存在' }
    }

    const conv = rows[0]
    if (conv.conv_status === CONV_STATUS.ARCHIVED) {
      return { success: false, message: '归档会话不能直接转入 AI 自助池，请先复活' }
    }
    if (conv.pool_type === POOL_TYPE.AI_SELF) {
      return { success: false, message: '会话已在 AI 自助池中' }
    }
    if (conv.pool_type === POOL_TYPE.PRIVATE && conv.claimed_by && Number(conv.claimed_by) !== Number(operatorId)) {
      return { success: false, message: '只能将自己认领的私有会话转入 AI 自助池' }
    }
    if (conv.pool_type === POOL_TYPE.LONG_TERM && conv.claimed_by && Number(conv.claimed_by) !== Number(operatorId)) {
      return { success: false, message: '只能将自己跟进的长期会话转入 AI 自助池' }
    }

    const result = await movePool({
      conversationId,
      targetPool: POOL_TYPE.AI_SELF,
      operatorId,
      operatorName,
      operatorType: 'agent',
      reason: '坐席手动转 AI 自助池',
      eventEmitter
    })

    return result
  } catch (err) {
    console.error('[PoolService] 手动转 AI 自助池失败:', err.message)
    return { success: false, message: '转 AI 自助池失败: ' + err.message }
  }
}

// ========== 公共 API：AI 转人工 ==========

async function getBusinessHoursStatus() {
  try {
    const configService = require('../../services/configService')
    const start = normalizeTimeString(await configService.getConfig('business_hours_start'), '09:00')
    const end = normalizeTimeString(await configService.getConfig('business_hours_end'), '18:00')
    return {
      start,
      end,
      isBusinessHours: isWithinBusinessHours(start, end)
    }
  } catch (err) {
    console.error('[PoolService] 读取工作时间配置失败，使用默认值:', err.message)
    const start = '09:00'
    const end = '18:00'
    return {
      start,
      end,
      isBusinessHours: isWithinBusinessHours(start, end)
    }
  }
}

function extractStoredMessageContent(content) {
  try {
    return typeof content === 'string' ? JSON.parse(content) : (content || {})
  } catch {
    return typeof content === 'string' ? { text: content } : (content || {})
  }
}

async function resolveLatestCustomerLanguage(conversationId) {
  try {
    const [rows] = await sequelize.query(
      `SELECT content
       FROM plat_messages
       WHERE conversation_id = :conversationId
         AND direction = 'inbound'
         AND sender_type = 'customer'
       ORDER BY created_at DESC
       LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) return { group: 'zh', code: 'zh', label: '中文' }

    const content = extractStoredMessageContent(rows[0].content)
    const normalized = normalizeCustomerLanguageInfo({
      group: content.originalLang && content.originalLang !== 'zh' ? 'other' : 'zh',
      code: content.originalLang || 'zh',
      label: content.langLabel
    })

    if (content.originalLang && content.originalLang !== 'unknown') {
      return normalized
    }

    const text = content.text || content.content || ''
    return detectLanguageHeuristically(text)
  } catch (err) {
    console.error('[PoolService] 获取客户语言失败，回退中文:', err.message)
    return { group: 'zh', code: 'zh', label: '中文' }
  }
}

async function buildAfterHoursTransferNotice(customerLanguage) {
  const configService = require('../../services/configService')
  const baseNotice = await configService.getConfig('after_hours_transfer_notice', DEFAULT_AFTER_HOURS_TRANSFER_NOTICE)
  const noticeText = typeof baseNotice === 'string' && baseNotice.trim()
    ? baseNotice.trim()
    : DEFAULT_AFTER_HOURS_TRANSFER_NOTICE

  const langInfo = normalizeCustomerLanguageInfo(customerLanguage)
  if (!langInfo || langInfo.group !== 'other') {
    return noticeText
  }

  try {
    const translateModel = await configService.getConfig('llm_translate_model')
    const { translateFromChinese } = require('../../services/translationService')
    const translated = await translateFromChinese(
      noticeText,
      langInfo.label || languageLabelFromCode(langInfo.code),
      translateModel
    )

    if (translated && translated.trim()) {
      return translated.trim()
    }
  } catch (err) {
    console.error('[PoolService] 生成非工作时间转人工提示失败，回退中文:', err.message)
  }

  return noticeText
}

async function sendAfterHoursTransferNotice(conversationId, eventEmitter, customerLanguage = null) {
  try {
    const [rows] = await sequelize.query(
      `SELECT channel, account_id, user_id
       FROM conversations
       WHERE id = :conversationId
       LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { success: false, message: '会话不存在，无法发送非工作时间提示' }
    }

    const conv = rows[0]
    // 优先使用传入的语言（来自 ai-auto-reply 的准确检测），否则回退到 DB 查询
    const resolvedLanguage = customerLanguage || await resolveLatestCustomerLanguage(conversationId)
    const langInfo = normalizeCustomerLanguageInfo(resolvedLanguage)

    // 客户语言未知时，不发送通知，只做静默转人工
    // 避免把中文默认通知发给语言未知的客户（可能英语/阿拉伯语等）
    if (!langInfo || langInfo.code === 'unknown' || langInfo.group === 'unknown') {
      console.log('[PoolService] 客户语言未知，跳过非工作时间通知发送，静默转人工')
      return { success: true, message: '客户语言未知，跳过通知发送，静默转人工' }
    }

    const noticeText = await buildAfterHoursTransferNotice(resolvedLanguage)

    // 语言兜底检查：即使上游 buildAfterHoursTransferNotice 已翻译，发送前再做一次安全网检查
    const { ensureOutputLanguage } = require('../../services/languageGuard')
    const guardedNoticeText = await ensureOutputLanguage(noticeText, conversationId, resolvedLanguage)

    const adapter = getChannelAdapterByChannel(conv.channel)
    const dispatcher = getDispatcher()
    const cloudPayload = {
      conversationId,
      localMessageId: `system-${conversationId}-${Date.now()}`,
      channel: conv.channel,
      accountId: conv.account_id,
      targetUserId: conv.user_id,
      messageType: 'text',
      content: { text: guardedNoticeText }
    }
    if (dispatcher) {
      const sendResult = await dispatcher.dispatch(cloudPayload)
      if (!sendResult.success) console.error('[PoolService] 统一出站分发非工作时间提示失败:', sendResult.error)
    } else if (adapter && conv.channel === 'whatsapp') {
      const sendResult = await adapter.sendMessage(conv.account_id, conv.user_id, { content: { text: guardedNoticeText }, messageType: 'text' })

      if (!sendResult.success) {
        console.error('[PoolService] 发送非工作时间转人工提示失败:', sendResult.error)
      }
    }

    await getMessagingService().sendAiReply({
      id: cloudPayload.localMessageId,
      conversationId,
      content: { text: guardedNoticeText },
      messageType: 'text'
    }, eventEmitter)

    return { success: true, message: '非工作时间提示已发送' }
  } catch (err) {
    console.error('[PoolService] 发送非工作时间转人工提示失败:', err.message)
    return { success: false, message: '发送非工作时间提示失败: ' + err.message }
  }
}

/**
 * AI 判断需要转人工时调用
 *
 * 从 AI自助池 → 待人工池
 *
 * @param {string} conversationId
 * @param {string} reason - 转人工原因
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function aiTransferToHuman(conversationId, reason, eventEmitter, customerLanguage = null) {
  try {
    const result = await movePool({
      conversationId,
      targetPool: POOL_TYPE.PENDING_HUMAN,
      operatorId: null,
      operatorName: 'AI',
      operatorType: 'ai',
      reason: reason || 'AI判断需人工介入',
      eventEmitter
    })

    if (result.success) {
      const businessHours = await getBusinessHoursStatus()
      if (!businessHours.isBusinessHours) {
        await sendAfterHoursTransferNotice(conversationId, eventEmitter, customerLanguage)
      }

      await logPoolAction({
        conversationId,
        action: POOL_ACTION.AI_TO_HUMAN,
        fromPool: POOL_TYPE.AI_SELF,
        toPool: POOL_TYPE.PENDING_HUMAN,
        operatorId: null,
        operatorName: 'AI',
        operatorType: 'ai',
        reason: reason || 'AI判断需人工介入'
      })
    }

    return result
  } catch (err) {
    console.error('[PoolService] AI转人工失败:', err.message)
    return { success: false, message: 'AI转人工失败: ' + err.message }
  }
}

// ========== 新消息入池路由 ==========

/**
 * 新消息到达时，根据会话当前池类型决定消息推送策略
 *
 * 规则：
 * - AI自助池：消息推送到 AI自助池房间，触发 AI 自动回复
 * - 待人工池/公共池：消息推送到对应池房间
 * - 私有池：消息推送给认领坐席
 * - 长期跟进池：消息推送给绑定坐席 + 高亮提醒
 * - 新会话：默认进入 AI 自助池
 *
 * @param {string} conversationId
 * @param {Object} message - 消息对象
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<{poolType: string, isNew: boolean}>}
 */
async function routeIncomingMessage(conversationId, message, eventEmitter) {
  try {
    // 查询会话当前池类型
    const [rows] = await sequelize.query(
      `SELECT pool_type, conv_status, claimed_by FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      // 会话不存在（不应该发生，findOrCreateConversation 已创建）
      return { poolType: POOL_TYPE.PENDING_HUMAN, isNew: true }
    }

    const conv = rows[0]

    // 更新最后回复方为客户
    await sequelize.query(
      `UPDATE conversations SET last_reply_by = :replyBy, last_reply_time = NOW() WHERE id = :conversationId`,
      { replacements: { replyBy: LAST_REPLY_BY.CUSTOMER, conversationId } }
    )

    if (conv.pool_type === POOL_TYPE.AI_SELF) {
      const config = await getPoolConfig()
      if (config.ai_self_pool_enabled === false) {
        const reason = 'AI自助聊天已关闭，转待人工处理'
        const result = await movePool({
          conversationId,
          targetPool: POOL_TYPE.PENDING_HUMAN,
          operatorId: null,
          operatorName: '系统',
          operatorType: 'system',
          reason,
          eventEmitter
        })

        if (result.success) {
          return {
            poolType: POOL_TYPE.PENDING_HUMAN,
            convStatus: CONV_STATUS.PENDING_CLAIM,
            claimedBy: null,
            isNew: false,
            reason
          }
        }

        return {
          poolType: POOL_TYPE.PENDING_HUMAN,
          convStatus: CONV_STATUS.PENDING_CLAIM,
          claimedBy: null,
          isNew: false,
          reason: result.message || reason
        }
      }

      const messageText = extractMessageText(message)
      if (messageText) {
        const handoffMatch = await matchCustomerHandoffKeyword({
          messageText,
          message,
          config
        })

        if (handoffMatch.matched) {
          const reason = buildCustomerHandoffReason(handoffMatch)
          const result = await aiTransferToHuman(
            conversationId,
            reason,
            eventEmitter,
            handoffMatch.customerLanguage
          )

          return {
            poolType: POOL_TYPE.PENDING_HUMAN,
            convStatus: CONV_STATUS.PENDING_CLAIM,
            claimedBy: null,
            isNew: false,
            reason: result.success ? reason : (result.message || reason)
          }
        }
      }
    }

    return {
      poolType: conv.pool_type || POOL_TYPE.PENDING_HUMAN,
      convStatus: conv.conv_status,
      claimedBy: conv.claimed_by,
      isNew: false
    }
  } catch (err) {
    console.error('[PoolService] 消息入池路由失败:', err.message)
    return { poolType: POOL_TYPE.PENDING_HUMAN, isNew: false }
  }
}

// ========== 池统计 ==========

/**
 * 获取各池的会话数量统计
 *
 * @param {number|null} seatId - 坐席 ID（私有池按坐席过滤）
 * @param {string} role - 用户角色（agent/supervisor/admin）
 * @returns {Promise<Object>} { ai_self, pending_human, public, long_term, private, all }
 */
async function getPoolStats(seatId, role) {
  try {
    const cacheKey = getPoolStatsCacheKey(seatId, role)
    const cached = poolStatsCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < POOL_STATS_CACHE_TTL_MS) {
      return cached.data
    }

    let privateCondition = ''
    let longTermCondition = ''
    const replacements = {}

    // 普通坐席只看自己的私有池和长期跟进池
    if (role === 'agent' && seatId) {
      privateCondition = 'AND claimed_by = :seatId'
      longTermCondition = 'AND claimed_by = :seatId'
      replacements.seatId = seatId
    }

    const [rows] = await sequelize.query(
      `SELECT
         SUM(CASE WHEN pool_type = 'ai_self' AND conv_status != 'archived' THEN 1 ELSE 0 END) AS ai_self,
         SUM(CASE WHEN pool_type = 'pending_human' AND conv_status != 'archived' THEN 1 ELSE 0 END) AS pending_human,
         SUM(CASE WHEN pool_type = 'public' AND conv_status != 'archived' THEN 1 ELSE 0 END) AS public_pool,
         SUM(CASE WHEN pool_type = 'long_term' AND conv_status != 'archived' ${longTermCondition} THEN 1 ELSE 0 END) AS long_term,
         SUM(CASE WHEN pool_type = 'private' AND conv_status != 'archived' ${privateCondition} THEN 1 ELSE 0 END) AS private_pool,
         SUM(CASE WHEN conv_status = 'archived' THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN conv_status != 'archived' THEN 1 ELSE 0 END) AS total
       FROM conversations`,
      { replacements }
    )

    const stats = rows[0] || {}
    const data = {
      ai_self: stats.ai_self || 0,
      pending_human: stats.pending_human || 0,
      public: stats.public_pool || 0,
      long_term: stats.long_term || 0,
      private: stats.private_pool || 0,
      archived: stats.archived || 0,
      all: stats.total || 0
    }
    poolStatsCache.set(cacheKey, { data, timestamp: Date.now() })
    if (poolStatsCache.size > 100) {
      const firstKey = poolStatsCache.keys().next().value
      poolStatsCache.delete(firstKey)
    }
    return data
  } catch (err) {
    console.error('[PoolService] 获取池统计失败:', err.message)
    return { ai_self: 0, pending_human: 0, public: 0, long_term: 0, private: 0, archived: 0, all: 0 }
  }
}

// ========== 操作日志 ==========

/**
 * 记录池操作日志
 *
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} params.action
 * @param {string|null} params.fromPool
 * @param {string|null} params.toPool
 * @param {number|null} params.operatorId
 * @param {string} params.operatorName
 * @param {string} params.operatorType
 * @param {string} params.reason
 */
async function logPoolAction(params) {
  try {
    const { conversationId, action, fromPool, toPool, operatorId, operatorName, operatorType, reason } = params
    await sequelize.query(
      `INSERT INTO conversation_pool_logs
        (conversation_id, action, from_pool, to_pool, operator_id, operator_name, operator_type, reason, created_at)
       VALUES (:conversationId, :action, :fromPool, :toPool, :operatorId, :operatorName, :operatorType, :reason, NOW())`,
      {
        replacements: {
          conversationId,
          action,
          fromPool: fromPool || null,
          toPool: toPool || null,
          operatorId: operatorId || null,
          operatorName: operatorName || '',
          operatorType: operatorType || 'system',
          reason: reason || ''
        }
      }
    )
    systemLogger.info('pool.action_logged', {
      conversationId,
      action,
      fromPool: fromPool || null,
      toPool: toPool || null,
      operatorId: operatorId || null,
      operatorName: operatorName || '',
      operatorType: operatorType || 'system',
      reason: reason || ''
    })
  } catch (err) {
    systemLogger.error('pool.action_log_failed', {
      conversationId: params?.conversationId,
      action: params?.action,
      fromPool: params?.fromPool || null,
      toPool: params?.toPool || null,
      error: err
    })
    console.error('[PoolService] 记录操作日志失败:', err.message)
  }
}

/**
 * 查询操作日志
 *
 * @param {Object} params - { conversationId, action, operatorId, operatorType, startDate, endDate, limit, offset }
 * @returns {Promise<{list: Array, total: number}>}
 */
async function getPoolLogs(params = {}) {
  try {
    const { conversationId, action, actions, operatorId, operatorType, fromPool, toPool, startDate, endDate, limit = 50, offset = 0 } = params
    const conditions = []
    const replacements = {}

    if (conversationId) {
      conditions.push('conversation_id = :conversationId')
      replacements.conversationId = conversationId
    }
    // 支持多选操作类型（逗号分隔）或单个操作
    if (actions && Array.isArray(actions) && actions.length > 0) {
      conditions.push('action IN (:actions)')
      replacements.actions = actions
    } else if (action) {
      conditions.push('action = :action')
      replacements.action = action
    }
    if (operatorId) {
      conditions.push('operator_id = :operatorId')
      replacements.operatorId = operatorId
    }
    if (operatorType) {
      conditions.push('operator_type = :operatorType')
      replacements.operatorType = operatorType
    }
    if (fromPool) {
      conditions.push('from_pool = :fromPool')
      replacements.fromPool = fromPool
    }
    if (toPool) {
      conditions.push('to_pool = :toPool')
      replacements.toPool = toPool
    }
    if (startDate) {
      conditions.push('created_at >= :startDate')
      replacements.startDate = startDate
    }
    if (endDate) {
      conditions.push('created_at <= :endDate')
      replacements.endDate = endDate
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

    const [rows] = await sequelize.query(
      `SELECT * FROM conversation_pool_logs ${whereClause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit: parseInt(limit), offset: parseInt(offset) } }
    )

    const [countResult] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM conversation_pool_logs ${whereClause}`,
      { replacements }
    )

    return { list: rows, total: countResult[0]?.total || 0 }
  } catch (err) {
    console.error('[PoolService] 查询操作日志失败:', err.message)
    return { list: [], total: 0 }
  }
}

// ========== 池配置管理 ==========

/**
 * 获取池配置
 * @param {string|null} key - 配置键名，不传则返回全部
 * @returns {Promise<Object>}
 */
async function getPoolConfig(key = null) {
  try {
    if (key) {
      const [rows] = await sequelize.query(
        `SELECT config_key, config_value, description FROM conversation_pool_config WHERE config_key = :key LIMIT 1`,
        { replacements: { key } }
      )
      if (rows.length === 0) return null
      let value = rows[0].config_value
      try {
        value = typeof value === 'string' ? JSON.parse(value) : value
      } catch { /* keep as string */ }
      return { key: rows[0].config_key, value, description: rows[0].description }
    }

    const [rows] = await sequelize.query(
      `SELECT config_key, config_value, description FROM conversation_pool_config`
    )
    const config = {}
    for (const row of rows) {
      let value = row.config_value
      try {
        value = typeof value === 'string' ? JSON.parse(value) : value
      } catch { /* keep as string */ }
      config[row.config_key] = value
    }
    return config
  } catch (err) {
    console.error('[PoolService] 获取池配置失败:', err.message)
    return key ? null : {}
  }
}

/**
 * 更新池配置
 * @param {string} key
 * @param {*} value
 * @param {number} updatedBy
 * @returns {Promise<boolean>}
 */
async function updatePoolConfig(key, value, updatedBy) {
  try {
    const valueStr = JSON.stringify(value)
    await sequelize.query(
      `INSERT INTO conversation_pool_config (config_key, config_value, updated_by, updated_at)
       VALUES (:key, :value, :updatedBy, NOW())
       ON DUPLICATE KEY UPDATE
         config_value = VALUES(config_value),
         updated_by = VALUES(updated_by),
         updated_at = NOW()`,
      { replacements: { key, value: valueStr, updatedBy } }
    )
    return true
  } catch (err) {
    console.error('[PoolService] 更新池配置失败:', err.message)
    return false
  }
}

// ========== 历史会话迁移 ==========

/**
 * 将现有会话迁移到新的池模型
 *
 * 规则：
 * - 有 agent_id 的 → private 池 (handling)
 * - 无 agent_id 且 status=open 的 → ai_self 池 (ai_serving)
 * - status=closed 的 → archived
 */
async function migrateExistingConversations() {
  try {
    // 有 agent_id 且 status=open → private
    const [r1] = await sequelize.query(
      `UPDATE conversations
       SET pool_type = :privatePool, conv_status = :handlingStatus, claimed_by = agent_id, claimed_at = updated_at
       WHERE agent_id IS NOT NULL AND status = 'open' AND pool_type IS NULL OR pool_type = 'ai_self'`,
      { replacements: { privatePool: POOL_TYPE.PRIVATE, handlingStatus: CONV_STATUS.HANDLING } }
    )
    console.log(`[PoolService] 迁移 ${r1.affectedRows} 个已分配会话到私有池`)

    // status=closed → archived
    const [r2] = await sequelize.query(
      `UPDATE conversations SET conv_status = :archived WHERE status = 'closed' AND conv_status != :archived`,
      { replacements: { archived: CONV_STATUS.ARCHIVED } }
    )
    console.log(`[PoolService] 迁移 ${r2.affectedRows} 个已关闭会话到归档`)

    return true
  } catch (err) {
    console.error('[PoolService] 历史会话迁移失败:', err.message)
    return false
  }
}

// ========== 公共 API：复活归档会话 ==========

/**
 * 复活归档会话
 *
 * 从 归档状态 → 待人工池
 * 用于坐席手动复活或客户发新消息时系统自动复活
 *
 * @param {string} conversationId
 * @param {number|null} seatId - 操作坐席 ID（系统自动复活时为 null）
 * @param {string} seatName
 * @param {EventEmitter} eventEmitter
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function reviveConversation(conversationId, seatId = null, seatName = '', eventEmitter) {
  try {
    // 检查会话是否已归档
    const [rows] = await sequelize.query(
      `SELECT id, conv_status FROM conversations WHERE id = :conversationId LIMIT 1`,
      { replacements: { conversationId } }
    )

    if (rows.length === 0) {
      return { success: false, message: '会话不存在' }
    }

    if (rows[0].conv_status !== CONV_STATUS.ARCHIVED) {
      return { success: false, message: '只能复活已归档的会话' }
    }

    // 复活：归档 → 待人工池
    const result = await movePool({
      conversationId,
      targetPool: POOL_TYPE.PENDING_HUMAN,
      operatorId: seatId,
      operatorName: seatName || '系统',
      operatorType: seatId ? 'agent' : 'system',
      reason: '手动复活归档会话',
      eventEmitter
    })

    if (result.success) {
      // 同时更新 status 字段（兼容旧字段）
      await sequelize.query(
        `UPDATE conversations SET status = 'open', updated_at = NOW() WHERE id = :conversationId`,
        { replacements: { conversationId } }
      )

      await logPoolAction({
        conversationId,
        action: 'revive',
        fromPool: null,
        toPool: POOL_TYPE.PENDING_HUMAN,
        operatorId: seatId,
        operatorName: seatName || '系统',
        operatorType: seatId ? 'agent' : 'system',
        reason: '手动复活归档会话'
      })
    }

    return result
  } catch (err) {
    console.error('[PoolService] 复活会话失败:', err.message)
    return { success: false, message: '复活失败: ' + err.message }
  }
}

module.exports = {
  // 池切换
  movePool,
  claimConversation,
  ensureClaimedForReply,
  releaseConversation,
  markLongTerm,
  archiveConversation,
  transferConversation,
  transferToAiSelf,
  reviveConversation,
  clearPoolStatsCache,
  aiTransferToHuman,
  // 消息路由
  routeIncomingMessage,
  // 坐席状态
  updateSeatStatus,
  syncSeatMaxConcurrent,
  getSeatLoad,
  getSeatMaxConcurrent,
  checkSeatCapacity,
  isSeatOfflineReleaseEnabled,
  releaseOnSeatOffline,
  // 统计与日志
  getPoolStats,
  logPoolAction,
  getPoolLogs,
  // 配置
  getPoolConfig,
  updatePoolConfig,
  // 迁移
  migrateExistingConversations
}
