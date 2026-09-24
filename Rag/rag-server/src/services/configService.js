/**
 * ConfigService — 统一配置服务
 *
 * 职责：
 * 1. 从 Redis 缓存读取配置，未命中则从 MySQL 读取并回填缓存
 * 2. 更新配置时清除 Redis 缓存 + Pub/Sub 通知所有实例刷新
 * 3. 提供类型安全的 get/set 接口（支持 boolean/number/string/json）
 *
 * 配置存储：conversation_pool_config 表（现有表，不新建 SystemConfig 表）
 * 缓存策略：Redis String (JSON)，TTL 3600 秒，更新时主动清除
 */

const fs = require('fs')
const path = require('path')
const { sequelize } = require('../config/database')
const redis = require('../config/redis')
const {
  REVIEW_DEFAULTS,
  getPublicAiConfigKeys,
  validatePublicAiConfig
} = require('../modules/message-review/reviewConfig')

const CACHE_PREFIX = 'config:'
const CACHE_TTL = 3600 // 1 小时
const CONFIG_RELOAD_CHANNEL = 'config:reload'

// ========== 从文件加载 AI 提示词（方便直接编辑，无需改代码） ==========
const PROMPT_FILE = path.join(__dirname, '../../prompts/ai_suggest_system_prompt.md')
let aiPromptFromFile = ''
try {
  aiPromptFromFile = fs.readFileSync(PROMPT_FILE, 'utf-8').trim()
  console.log(`[ConfigService] 已加载提示词文件: ${PROMPT_FILE} (${aiPromptFromFile.length} 字符)`)
} catch (e) {
  console.warn(`[ConfigService] 未找到提示词文件 ${PROMPT_FILE}，使用内置默认值`)
  aiPromptFromFile = '你是客服坐席的智能助手，负责根据用户消息和知识库资料生成推荐回复。'
}

// ========== 配置默认值（代码层 fallback，数据库和缓存都没有时用） ==========
const DEFAULTS = {
  ai_self_pool_enabled: true,
  ai_max_rounds: 0,
  ai_no_reply_timeout_enabled: true,
  ai_no_reply_timeout: 1800,
  ai_confidence_threshold: 0.7,
  ai_confidence_cautious_min: 0.4, // 三层策略：低置信度区间下限，此值~threshold 区间 AI 谨慎回答+承诺确认
  complexity_check_enabled: true,
  sentiment_check_enabled: true,
  pending_human_aging_timeout_enabled: true,
  pending_human_aging_timeout: 3600,
  public_pool_archive_timeout: 86400,
  seat_offline_release: true,
  long_term_reminder_hours: 48,
  ai_self_stale_timeout: 1800,
  private_pool_stale_timeout_enabled: true,
  private_pool_stale_timeout: 3600,
  business_hours_start: '09:00',
  business_hours_end: '18:00',
  after_hours_transfer_notice: '现在是非工作时间段，我手头没有资料，等工作时间再跟您详聊。',
  ai_transfer_keywords: ['转人工', '人工客服', '找人工', '人工', '转接人工', '我要人工'],
  // 新增运营配置
  ai_queue_concurrency: 5,
  ai_retry_limit: 3,
  ai_timeout_ms: 30000,
  seat_max_concurrent: 5,
  // LLM 大模型配置（DashScope 百炼兼容模式支持的模型名）
  // qwen3.7-plus/qwen3.6-flash 是 Qwen3 系列最新版（支持混合思考模式）
  // deepseek-v4-pro/deepseek-v4-flash 是 DeepSeek 阿里云直供版
  // 默认统一使用 deepseek-v4-flash（兼顾速度、成本与推理能力）
  ai_self_reply_model: 'deepseek-v4-flash',
  ai_suggest_model: 'deepseek-v4-flash',
  llm_translate_model: 'deepseek-v4-flash',
  translation_context_message_count: 3,
  rag_context_message_count: 0,
  llm_context_message_count: 20,
  llm_suggest_models: ['deepseek-v4-flash', 'deepseek-v4-pro','qwen3.6-flash','qwen3.7-plus' ],
  // AI 推荐回答并发限制（同时进行的 LLM 调用数）
  ai_suggest_concurrency: 3,
  // AI 自助回复回答有效性校验
  ai_reply_validation_enabled: true,
  ai_reply_validation_model: 'deepseek-v4-flash',
  // AI 推荐回答系统提示词（从 prompts/ai_suggest_system_prompt.md 文件加载）
  ai_suggest_system_prompt: aiPromptFromFile,
  // 连续消息合并/串行锁参数（可通过管理后台 Settings 动态调整）
  ai_reply_debounce_ms: 1500,
  ai_merge_window_seconds: 120,
  ai_merge_max_messages: 5,
  ai_reply_lock_ttl_ms: 120000,
  // 语言兜底检查（全局开关，默认开启。所有发给客户的文本消息都会检查语言是否匹配）
  language_guard_enabled: true,
  ai_reply_lock_wait_ms: 12000,
  ...REVIEW_DEFAULTS
}

// ========== 内部缓存（进程内，避免同一配置项在同一进程内频繁查 Redis） ==========
const localCache = new Map()
let redisSubscribed = false

/**
 * 初始化：订阅 Redis Pub/Sub 配置刷新通知
 * 在 app.js 启动时调用
 */
async function initConfigService() {
  if (redisSubscribed) return
  redisSubscribed = true

  await redis.subscribe(CONFIG_RELOAD_CHANNEL, (data) => {
    const { key } = data
    // 清除进程内缓存
    localCache.delete(key)
    console.log(`[ConfigService] 配置已刷新: ${key}`)
  })

  console.log('[ConfigService] 已订阅配置刷新通知')
}

/**
 * 从数据库读取配置项
 * @param {string} key
 * @returns {Promise<*|undefined>}
 */
async function readFromDb(key) {
  try {
    const [rows] = await sequelize.query(
      `SELECT config_value FROM conversation_pool_config WHERE config_key = :key LIMIT 1`,
      { replacements: { key } }
    )
    if (rows.length === 0) return undefined

    let value = rows[0].config_value
    // config_value 可能是 JSON 类型，也可能是字符串
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        // 保持字符串
      }
    }
    return value
  } catch (err) {
    console.error('[ConfigService] DB读取失败:', key, err.message)
    return undefined
  }
}

/**
 * 获取配置值（带缓存）
 *
 * 读取顺序：进程内缓存 → Redis 缓存 → MySQL → 默认值
 *
 * @param {string} key - 配置键名
 * @param {*} defaultValue - 默认值（不传则使用 DEFAULTS 中的值）
 * @returns {Promise<*>}
 */
async function getConfig(key, defaultValue = undefined) {
  // 1. 进程内缓存
  if (localCache.has(key)) {
    return localCache.get(key)
  }

  // 2. Redis 缓存
  const redisValue = await redis.getJson(CACHE_PREFIX + key)
  if (redisValue !== null) {
    localCache.set(key, redisValue)
    return redisValue
  }

  // 3. MySQL
  const dbValue = await readFromDb(key)
  if (dbValue !== undefined) {
    // 回填 Redis 缓存
    await redis.setJson(CACHE_PREFIX + key, dbValue, CACHE_TTL)
    localCache.set(key, dbValue)
    return dbValue
  }

  // 4. 默认值
  const fallback = defaultValue !== undefined ? defaultValue : DEFAULTS[key]
  return fallback
}

/**
 * 获取所有配置（一次性读取，用于前端展示）
 * @returns {Promise<Object>}
 */
async function getAllConfig() {
  try {
    const [rows] = await sequelize.query(
      `SELECT config_key, config_value, description FROM conversation_pool_config`
    )

    const config = {}
    for (const row of rows) {
      let value = row.config_value
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch {
          // 保持字符串
        }
      }
      config[row.config_key] = {
        value,
        description: row.description
      }
    }

    // 合并默认值（数据库中没有的用默认值填充）
    for (const [key, val] of Object.entries(DEFAULTS)) {
      if (!config[key]) {
        config[key] = { value: val, description: '' }
      }
    }

    return config
  } catch (err) {
    console.error('[ConfigService] 获取全部配置失败:', err.message)
    return {}
  }
}

/**
 * 更新配置
 *
 * 写入 MySQL → 清除 Redis 缓存 → 清除进程内缓存 → Pub/Sub 通知
 *
 * @param {string} key
 * @param {*} value
 * @param {number|null} updatedBy - 操作人 ID
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function updateConfig(key, value, updatedBy = null) {
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

    // 清除 Redis 缓存
    await redis.del(CACHE_PREFIX + key)

    // 清除进程内缓存
    localCache.delete(key)

    // Pub/Sub 通知其他实例
    await redis.publish(CONFIG_RELOAD_CHANNEL, { key, value })

    console.log(`[ConfigService] 配置已更新: ${key} =`, value)
    return { success: true, message: '配置更新成功' }
  } catch (err) {
    console.error('[ConfigService] 更新配置失败:', err.message)
    return { success: false, message: '配置更新失败: ' + err.message }
  }
}

async function getPublicAiConfig() {
  const allConfig = await getAllConfig()
  return Object.fromEntries(
    getPublicAiConfigKeys().map((key) => [key, allConfig[key] || {
      value: DEFAULTS[key],
      description: ''
    }])
  )
}

async function updatePublicAiConfig(key, value, updatedBy = null) {
  const normalizedValue = validatePublicAiConfig(key, value)
  return updateConfig(key, normalizedValue, updatedBy)
}

/**
 * 启动时预加载所有配置到 Redis 缓存
 */
async function preloadConfigs() {
  try {
    const [rows] = await sequelize.query(
      `SELECT config_key, config_value FROM conversation_pool_config`
    )

    for (const row of rows) {
      let value = row.config_value
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch {
          // 保持字符串
        }
      }
      await redis.setJson(CACHE_PREFIX + row.config_key, value, CACHE_TTL)
      localCache.set(row.config_key, value)
    }

    console.log(`[ConfigService] 已预加载 ${rows.length} 条配置到缓存`)
  } catch (err) {
    console.error('[ConfigService] 预加载配置失败:', err.message)
  }
}

module.exports = {
  initConfigService,
  getConfig,
  getAllConfig,
  getPublicAiConfig,
  updateConfig,
  updatePublicAiConfig,
  preloadConfigs,
  DEFAULTS
}
