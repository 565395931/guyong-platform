/**
 * Redis 连接模块
 *
 * 三大用途：
 * 1. BullMQ 队列后端（AI 回复队列）
 * 2. 配置缓存（系统配置项缓存）
 * 3. Pub/Sub（配置刷新通知）
 *
 * 启动 Redis：cd docker/redis && docker compose up -d
 */

const Redis = require('ioredis')

// ========== Redis 连接配置 ==========
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: null,  // BullMQ 要求设置为 null
  enableOfflineQueue: true,    // 断连后排队等待重连
  connectTimeout: 10000,       // 连接超时 10 秒
  retryStrategy(times) {
    // 前3次快速重试，之后降频为每5秒一次，持续重试不让进程退出
    if (times > 3) {
      return 5000
    }
    return Math.min(times * 500, 2000)
  }
}

// ========== 主连接（BullMQ 队列 + 缓存读写共用） ==========
const redisClient = new Redis(redisConfig)

redisClient.on('connect', () => {
  console.log('[Redis] 已连接')
})

redisClient.on('error', (err) => {
  console.error('[Redis] 连接错误:', err.message)
})

// ========== Pub/Sub 专用连接 ==========
// Redis 中订阅和发布需要独立连接
const pubClient = new Redis(redisConfig)
const subClient = new Redis(redisConfig)

subClient.on('connect', () => {
  console.log('[Redis] Pub/Sub 订阅已连接')
})

/**
 * 发布配置变更通知
 * @param {string} channel - 频道名
 * @param {Object} data - 通知数据
 */
async function publish(channel, data) {
  await pubClient.publish(channel, JSON.stringify(data))
}

/**
 * 订阅频道
 * @param {string} channel - 频道名
 * @param {Function} handler - 消息处理函数 (data: Object) => void
 */
async function subscribe(channel, handler) {
  await subClient.subscribe(channel)
  subClient.on('message', (ch, message) => {
    if (ch === channel) {
      try {
        const data = JSON.parse(message)
        handler(data)
      } catch (e) {
        console.error(`[Redis] 解析消息失败 (${channel}):`, e.message)
      }
    }
  })
}

// ========== 缓存工具函数 ==========

/**
 * 读取缓存
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function get(key) {
  return redisClient.get(key)
}

/**
 * 写入缓存（带过期时间）
 * @param {string} key
 * @param {string} value
 * @param {number} ttlSeconds - 过期秒数（0 = 不过期）
 */
async function set(key, value, ttlSeconds = 0) {
  if (ttlSeconds > 0) {
    await redisClient.set(key, value, 'EX', ttlSeconds)
  } else {
    await redisClient.set(key, value)
  }
}

/**
 * 删除缓存
 * @param {string} key
 */
async function del(key) {
  await redisClient.del(key)
}

/**
 * 读取缓存并反序列化为 JSON
 * @param {string} key
 * @returns {Promise<*|null>}
 */
async function getJson(key) {
  const raw = await redisClient.get(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 将对象序列化为 JSON 写入缓存
 * @param {string} key
 * @param {*} value
 * @param {number} ttlSeconds
 */
async function setJson(key, value, ttlSeconds = 0) {
  await set(key, JSON.stringify(value), ttlSeconds)
}

module.exports = {
  redisClient,
  pubClient,
  subClient,
  redisConfig,
  publish,
  subscribe,
  get,
  set,
  del,
  getJson,
  setJson
}
