/**
 * 头像服务 - 从 WAHA 获取联系人头像并本地存储
 *
 * 核心职责：
 * 1. 调用 WAHA API 获取联系人头像 URL
 * 2. 下载头像图片到本地 public/avatars/ 目录
 * 3. 更新 conversations.user_avatar 字段
 * 4. 提供 ensureAvatar 按需获取（已有则跳过）
 *
 * 存储策略：
 * - WhatsApp CDN URL 会过期，所以下载到本地永久存储
 * - 文件名：conversationId.jpg
 * - 访问路径：/api/avatars/<conversationId>.jpg（由 app.js express.static 提供服务）
 */

const path = require('path')
const fs = require('fs')
const axios = require('axios')
const { sequelize } = require('../config/database')
const { getWahaClientByAccount } = require('../shared/utils/wahaClient')

const AVATAR_DIR = path.join(__dirname, '..', 'public', 'avatars')

// ========== 代理配置（用于下载 WhatsApp CDN 图片，服务器在中国大陆需走代理）==========
let _proxyAgent = null
function getProxyAgent() {
  if (_proxyAgent !== null) return _proxyAgent // 缓存（包括 false）
  const proxyServer = process.env.WHATSAPP_PROXY_SERVER
  if (!proxyServer) {
    _proxyAgent = false
    return false
  }
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    const proxyUser = process.env.WHATSAPP_PROXY_SERVER_USERNAME
    const proxyPass = process.env.WHATSAPP_PROXY_SERVER_PASSWORD
    let proxyUrl = proxyServer
    if (proxyUser && proxyPass) {
      // 拼接认证信息: http://user:pass@host:port
      proxyUrl = `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@${proxyServer}`
    } else {
      proxyUrl = `http://${proxyServer}`
    }
    _proxyAgent = new HttpsProxyAgent(proxyUrl)
    console.log(`[AvatarService] 代理已配置: ${proxyServer}`)
    return _proxyAgent
  } catch (e) {
    console.warn('[AvatarService] 代理初始化失败:', e.message)
    _proxyAgent = false
    return false
  }
}

/**
 * 确保头像目录存在
 */
function ensureAvatarDir() {
  if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true })
  }
}

const DEFAULT_AVATAR_HOSTS = Object.freeze([
  'whatsapp.net',
  'fbcdn.net',
  'fbsbx.com'
])

function configuredAvatarHosts(environment = process.env) {
  const extra = String(environment.AVATAR_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
  return [...DEFAULT_AVATAR_HOSTS, ...extra]
}

function isAllowedAvatarUrl(value, environment = process.env) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    return configuredAvatarHosts(environment).some(
      allowed => hostname === allowed || hostname.endsWith(`.${allowed}`)
    )
  } catch {
    return false
  }
}

function isGroupChatId(chatId) {
  return typeof chatId === 'string' && chatId.trim().endsWith('@g.us')
}

function isLidChatId(chatId) {
  return typeof chatId === 'string' && chatId.trim().includes('@lid')
}

function getAvatarExtension(contentType = '') {
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
  return '.jpg'
}

function extractAvatarUrl(payload) {
  if (!payload || typeof payload !== 'object') return null
  const imageUrl = payload.url || payload.profilePictureURL || payload.profilePicUrl || payload.picture || payload.eurl
  return isAllowedAvatarUrl(imageUrl) ? imageUrl : null
}

async function resolveLidToPhoneChatId(wahaClient, sessionName, chatId) {
  if (!isLidChatId(chatId)) return null

  try {
    const response = await wahaClient.get(`/api/${sessionName}/lids/${encodeURIComponent(chatId)}`, {
      timeout: 5000,
      headers: { Accept: 'application/json' }
    })
    const resolved = response.data?.pn || response.data?.chatId || response.data?.id || null
    if (typeof resolved === 'string' && resolved.includes('@c.us')) {
      console.log(`[AvatarService] LID ${chatId} resolved to ${resolved}`)
      return resolved
    }
    console.warn(`[AvatarService] LID ${chatId} did not resolve to a phone chatId`)
    return null
  } catch (err) {
    console.warn(`[AvatarService] LID ${chatId} resolution failed:`, err.response?.data || err.message)
    return null
  }
}

async function buildAvatarChatIdCandidates(wahaClient, sessionName, chatId) {
  const normalized = String(chatId || '').trim()
  const candidates = []

  const resolved = await resolveLidToPhoneChatId(wahaClient, sessionName, normalized)
  if (resolved) candidates.push(resolved)
  if (normalized && !candidates.includes(normalized)) candidates.push(normalized)

  return candidates
}

/**
 * 从 WAHA 获取联系人头像 URL
 * WAHA 端点：GET /api/:session/chats/:chatId/picture
 * 返回格式：{ "url": "https://pps.whatsapp.net/..." } 或 { "mimetype": "image/jpeg", "url": "..." }
 *
 * @param {object} wahaClient - axios 实例
 * @param {string} sessionName - WAHA session 名称
 * @param {string} chatId - WhatsApp chatId（如 8613800138000@c.us 或 xxx@lid）
 * @returns {Promise<string|null>} 头像 URL 或 null（无头像/出错）
 */
async function fetchAvatarFromWaha(wahaClient, sessionName, chatId) {
  try {
    const response = await wahaClient.get(`/api/${sessionName}/chats/${encodeURIComponent(chatId)}/picture`, {
      timeout: isGroupChatId(chatId) ? 4000 : 10000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      headers: { Accept: 'application/json,image/*,*/*' }
    })

    if (response.status === 404) {
      console.log(`[AvatarService] ${chatId} has no avatar`)
      return null
    }
    if (response.status < 200 || response.status >= 300) {
      const preview = Buffer.isBuffer(response.data) ? response.data.toString('utf8', 0, 300) : ''
      console.warn(`[AvatarService] WAHA returned ${response.status} for ${chatId} avatar: ${preview}`)
      return null
    }

    const contentType = String(response.headers['content-type'] || '').toLowerCase()
    const body = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '')

    if (contentType.startsWith('image/') && body.length > 0) {
      return { type: 'buffer', buffer: body, contentType }
    }

    if (contentType.includes('json') || body.toString('utf8', 0, 1) === '{') {
      try {
        const payload = JSON.parse(body.toString('utf8'))
        const imageUrl = extractAvatarUrl(payload)
        if (imageUrl) {
          return { type: 'url', url: imageUrl }
        }
      } catch (parseErr) {
        console.warn(`[AvatarService] WAHA avatar JSON parse failed for ${chatId}:`, parseErr.message)
      }
      console.log(`[AvatarService] ${chatId} did not return an avatar URL`)
      return null
    }

    const text = body.toString('utf8').trim()
    if (isAllowedAvatarUrl(text)) {
      return { type: 'url', url: text }
    }

    console.warn(`[AvatarService] WAHA returned unknown avatar format for ${chatId}: ${contentType || 'no content-type'}`)
    return null
  } catch (err) {
    console.error(`[AvatarService] fetch avatar failed for ${chatId}:`, err.message)
    return null
  }
}

/**
 * 下载头像图片到本地
 *
 * @param {string} imageUrl - 远程图片 URL
 * @param {string} conversationId - 会话 ID（用作文件名）
 * @returns {Promise<string|null>} 本地访问路径（如 /api/avatars/xxx.jpg）或 null
 */
async function downloadAndSaveAvatar(imageUrl, conversationId) {
  try {
    if (!isAllowedAvatarUrl(imageUrl)) {
      throw new Error('头像地址不在允许的 HTTPS 域名范围内')
    }
    ensureAvatarDir()

    const proxyAgent = getProxyAgent()
    const axiosConfig = {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 5 * 1024 * 1024, // 限制 5MB
      maxBodyLength: 5 * 1024 * 1024,
      maxRedirects: 0
    }
    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.httpAgent = proxyAgent
      // 禁用 axios 内置 proxy 处理，使用 httpsAgent 代替
      axiosConfig.proxy = false
    }

    const response = await axios.get(imageUrl, axiosConfig)

    // 根据 content-type 确定扩展名
    const contentType = String(response.headers['content-type'] || '').toLowerCase()
    if (!contentType.startsWith('image/') || !response.data?.length) {
      throw new Error('头像响应不是有效图片')
    }
    const ext = getAvatarExtension(contentType)

    const filename = `${conversationId}${ext}`
    const filepath = path.join(AVATAR_DIR, filename)

    // 删除旧文件（可能是不同扩展名）
    removeOldAvatar(conversationId)

    fs.writeFileSync(filepath, response.data)
    const localPath = `/api/avatars/${filename}`

    console.log(`[AvatarService] 头像已保存: ${localPath} (${response.data.length} bytes)`)
    return localPath
  } catch (err) {
    console.error(`[AvatarService] 下载头像失败 ${imageUrl}:`, err.message)
    return null
  }
}

async function saveAvatarBuffer(buffer, conversationId, contentType = '') {
  try {
    ensureAvatarDir()

    const ext = getAvatarExtension(contentType)
    const filename = `${conversationId}${ext}`
    const filepath = path.join(AVATAR_DIR, filename)

    removeOldAvatar(conversationId)
    fs.writeFileSync(filepath, buffer)

    const localPath = `/api/avatars/${filename}`
    console.log(`[AvatarService] 头像已保存: ${localPath} (${buffer.length} bytes)`)
    return localPath
  } catch (err) {
    console.error('[AvatarService] 保存头像失败:', err.message)
    return null
  }
}

/**
 * 删除旧的头像文件（可能是不同扩展名）
 */
function removeOldAvatar(conversationId) {
  const extensions = ['.jpg', '.png', '.webp']
  for (const ext of extensions) {
    const filepath = path.join(AVATAR_DIR, `${conversationId}${ext}`)
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath)
      } catch {
        // 忽略删除失败
      }
    }
  }
}

/**
 * 更新 conversations 表的 user_avatar 字段
 */
async function updateConversationAvatar(conversationId, avatarPath) {
  try {
    await sequelize.query(
      `UPDATE conversations SET user_avatar = :avatarPath, updated_at = NOW() WHERE id = :convId`,
      { replacements: { avatarPath, convId: conversationId } }
    )
  } catch (err) {
    console.error(`[AvatarService] 更新头像字段失败:`, err.message)
  }
}

/**
 * 确保会话有头像 — 如果没有则从 WAHA 获取
 *
 * 核心入口函数，用于：
 * - 新会话创建时异步调用
 * - 前端手动触发刷新
 * - 批量回填
 *
 * @param {string} conversationId - 会话 UUID
 * @param {number|null} accountId - 渠道账号 ID
 * @param {string} chatId - WhatsApp chatId（conversations.user_id）
 * @param {object} options - { force: boolean } 强制刷新（忽略已有头像）
 * @returns {Promise<{success: boolean, avatar: string|null, reason: string}>}
 */
async function ensureAvatar(conversationId, accountId, chatId, options = {}) {
  const { force = false } = options

  if (!chatId) {
    return { success: false, avatar: null, reason: '缺少 chatId' }
  }

  // 非强制模式下，先检查是否已有头像
  if (!force) {
    try {
      const [rows] = await sequelize.query(
        `SELECT user_avatar FROM conversations WHERE id = :convId`,
        { replacements: { convId: conversationId } }
      )
      if (rows.length > 0 && rows[0].user_avatar) {
        return { success: true, avatar: rows[0].user_avatar, reason: '已有头像' }
      }
    } catch {
      // 查询失败，继续尝试获取
    }
  }

  // 获取 WAHA 客户端
  const waha = await getWahaClientByAccount(accountId)
  if (!waha) {
    return { success: false, avatar: null, reason: '无可用 WAHA 实例' }
  }

  // 从 WAHA 获取头像。LID 会先解析为手机号 JID；群聊保留原 chatId，但使用更短超时。
  const candidates = await buildAvatarChatIdCandidates(waha.client, waha.sessionName, chatId)
  let avatar = null
  for (const candidate of candidates) {
    avatar = await fetchAvatarFromWaha(waha.client, waha.sessionName, candidate)
    if (avatar) break
  }

  if (!avatar) {
    // 记录为空字符串，避免重复尝试（可用特殊标记）
    if (force) {
      await updateConversationAvatar(conversationId, '')
    }
    if (isGroupChatId(chatId)) {
      return { success: false, avatar: null, reason: 'WAHA 未返回群头像（群可能未设置头像，或当前无法读取群资料）' }
    }
    if (isLidChatId(chatId) && candidates.length === 1) {
      return { success: false, avatar: null, reason: 'WAHA 未能将 LID 解析为手机号，无法获取头像' }
    }
    return { success: false, avatar: null, reason: 'WAHA 未返回头像（联系人可能未设置或隐私不可见）' }
  }

  // 下载并保存头像
  const localPath = avatar.type === 'buffer'
    ? await saveAvatarBuffer(avatar.buffer, conversationId, avatar.contentType)
    : await downloadAndSaveAvatar(avatar.url, conversationId)
  if (!localPath) {
    return { success: false, avatar: null, reason: '下载头像失败' }
  }

  // 更新数据库
  await updateConversationAvatar(conversationId, localPath)

  return { success: true, avatar: localPath, reason: '获取成功' }
}

/**
 * 批量为没有头像的会话获取头像
 * 用于一次性回填现有会话的头像
 *
 * @param {number} batchSize - 每批处理数量
 * @param {function} onProgress - 进度回调 (processed, total, current)
 * @returns {Promise<{total: number, success: number, failed: number, skipped: number}>}
 */
async function batchFetchAvatars(batchSize = 20, onProgress = null, { accountId = null } = {}) {
  const accountCondition = accountId ? 'AND account_id = :accountId' : ''
  // 查询没有头像的 WhatsApp 会话（user_id 可能是 @c.us 或 @lid 格式）
  const [conversations] = await sequelize.query(
    `SELECT id, account_id, user_id FROM conversations
     WHERE channel = 'whatsapp'
       AND (user_avatar IS NULL OR user_avatar = '')
       AND user_id IS NOT NULL
       AND (user_id LIKE '%@c.us' OR user_id LIKE '%@lid')
       ${accountCondition}
     ORDER BY last_message_time DESC
     LIMIT :limit`,
    { replacements: { limit: batchSize, accountId: accountId ? Number(accountId) : null } }
  )

  const total = conversations.length
  let success = 0
  let failed = 0
  let skipped = 0

  console.log(`[AvatarService] 批量获取头像: ${total} 个会话`)

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]
    try {
      const result = await ensureAvatar(conv.id, conv.account_id, conv.user_id, { force: true })
      if (result.success) {
        success++
      } else if (result.reason.includes('未返回头像')) {
        skipped++
      } else {
        failed++
      }
    } catch {
      failed++
    }

    if (onProgress) {
      onProgress(i + 1, total, conv)
    }

    // 每个请求之间间隔 500ms，避免 WAHA 过载
    if (i < conversations.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  console.log(`[AvatarService] 批量获取完成: ${success} 成功, ${skipped} 无头像, ${failed} 失败`)
  return { total, success, failed, skipped }
}

module.exports = {
  ensureAvatar,
  batchFetchAvatars,
  fetchAvatarFromWaha,
  downloadAndSaveAvatar,
  isAllowedAvatarUrl,
  extractAvatarUrl
}
