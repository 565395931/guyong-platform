/**
 * WAHA WhatsApp 适配器
 *
 * 实现 BaseAdapter 接口，对接 WAHA (WhatsApp HTTP API) 网关。
 *
 * WAHA API 参考：
 * - 发送文本消息：POST {baseURL}/api/sendText
 *   body: { session: "sessionName", chatId: "8613800138000@c.us", text: "你好" }
 * - 认证：Header X-Api-Key: {apiKey}
 *
 * 环境变量：
 *   WAHA_API_URL  - WAHA 实例默认地址（如 http://localhost:3000）
 *   WAHA_API_KEY  - WAHA 默认 API Key
 *   WAHA_SESSION  - 默认 session 名称
 */

const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const BaseAdapter = require('../base')
const wahaFormat = require('./wahaFormat')
const { sequelize } = require('../../../config/database')
const { parseWahaAccountConfig } = require('../../../shared/utils/wahaConfig')

const INCOMING_MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'public', 'media-files')
const PUBLIC_MEDIA_PREFIX = '/api/media-files/static'

class WahaAdapter extends BaseAdapter {
  constructor() {
    super()
    this.channel = 'whatsapp'
    this.adapterType = 'waha'
    // 默认值从环境变量读取，单个账号可在 config 中覆盖
    this.baseURL = process.env.WAHA_API_URL || 'http://localhost:3000'
    this.apiKey = process.env.WAHA_API_KEY || ''
    this.sessionName = process.env.WAHA_SESSION || 'default'
    this.selfChatIdCache = new Map()
  }

  /**
   * 接收 WAHA Webhook 事件
   * @param {Object} payload - WAHA Webhook body
   * @returns {Promise<Array>} StandardMessage[]
   */
  async receiveEvent(payload) {
    try {
      // accountId 通过 webhook 路由传入，暂从 payload.session 反查
      // 此处先返回标准消息，accountId 由路由层补充
      const accountId = payload?._accountId || (Array.isArray(payload) ? payload.find(evt => evt?._accountId)?._accountId : null) || null
      const accountConfig = accountId ? await this._getAccountConfig(accountId) : null
      const rawMessages = wahaFormat.toStandardMessages(payload, accountId)
      const messages = []
      for (const message of rawMessages) {
        if (await this._isSendingAccountChatId(accountConfig, message.channelUserId)) {
          console.log('[WAHA] skip webhook message from sending account chatId:', message.channelUserId)
          continue
        }
        await this._downloadIncomingMedia(message, accountId)
        messages.push(message)
      }
      return messages
    } catch (err) {
      console.error('[WAHA] receiveEvent 失败:', err.message)
      return []
    }
  }

  /**
   * 发送消息到 WhatsApp 用户
   *
   * 当前 WAHA 文档确认可用接口：
   * - POST /api/sendText: { session, chatId, text }
   * - POST /api/sendImage: { session, chatId, file: { mimetype, filename, url }, caption }
   * - POST /api/sendVideo: { session, chatId, file: { mimetype, filename, url }, caption, convert }
   * - POST /api/sendFile: { session, chatId, file: { mimetype, filename, url }, caption }
   *
   * @param {number} accountId - 平台渠道账号 ID
   * @param {string} targetUserId - 接收者 ID（如 8613800138000@c.us）
   * @param {Object} standardMessage - 平台标准消息体
   * @returns {Promise<{ success: boolean, channelMsgId?: string, error?: string }>}
   */
  async downloadIncomingMedia(message, accountId) {
    return this._downloadIncomingMedia(message, accountId)
  }

  async sendMessage(accountId, targetUserId, standardMessage) {
    try {
      // 1. 查询账号配置
      const accountConfig = await this._getAccountConfig(accountId)

      // 2. 按消息类型构建 WAHA 请求
      const messageType = standardMessage.messageType || standardMessage.type || 'text'
      const content = standardMessage.content || {}
      const chatIdResult = await this._resolveSendChatId(accountConfig, targetUserId)
      if (!chatIdResult.success) {
        const { success, ...failure } = chatIdResult
        return { success: false, ...failure }
      }

      const request = this._buildSendRequest(accountConfig, chatIdResult.chatId, messageType, content)
      if (!request.success) {
        return { success: false, error: request.error }
      }

      // 3. 调用 WAHA 发送 API
      const response = await axios.post(request.url, request.body, {
        headers: {
          'X-Api-Key': accountConfig.apiKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: messageType === 'video' ? 60000 : 30000
      })

      // 4. 提取渠道消息 ID（WAHA 可能返回对象，需要规范化为字符串后入库）
      const channelMsgId = this._extractChannelMessageId(response.data)
      if (!channelMsgId) {
        const responseSummary = this._summarizeWahaResponse(response.data)
        console.error('[WAHA] sendMessage returned without message id:', responseSummary)
        return {
          success: false,
          error: `WAHA did not return a message id; message delivery is not confirmed. Response: ${responseSummary}`
        }
      }

      return { success: true, channelMsgId, chatId: chatIdResult.chatId }
    } catch (err) {
      console.error('[WAHA] sendMessage 失败:', err.message)
      const errMsg = err.response?.data?.message || err.response?.data?.error || err.message
      return { success: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg) }
    }
  }

  async _resolveSendChatId(accountConfig, targetUserId) {
    const chatId = String(targetUserId || '').trim()
    if (!chatId) {
      return { success: false, error: 'WhatsApp recipient chatId is empty' }
    }
    const accountPhone = this._extractDigits(accountConfig.phoneNumber)
    const directRecipientPhone = this._extractPhoneFromChatId(chatId)
    if (accountPhone && directRecipientPhone && accountPhone === directRecipientPhone) {
      return {
        success: false,
        reason: 'self_recipient',
        resolvedChatId: chatId,
        error: `WhatsApp recipient ${chatId} is the same as the sending account phone ${accountConfig.phoneNumber}; refusing to send to self.`
      }
    }

    if (!chatId.includes('@lid')) {
      return { success: true, chatId }
    }

    try {
      const response = await axios.get(
        `${accountConfig.wahaInstanceUrl}/api/${accountConfig.sessionName}/lids/${encodeURIComponent(chatId)}`,
        {
          headers: {
            'X-Api-Key': accountConfig.apiKey,
            'Accept': 'application/json'
          },
          timeout: 5000
        }
      )
      const resolved = response.data?.pn || response.data?.chatId || response.data?.id || null
      if (typeof resolved === 'string' && resolved.includes('@c.us')) {
        const resolvedPhone = this._extractPhoneFromChatId(resolved)
        if (accountPhone && resolvedPhone && accountPhone === resolvedPhone) {
          return {
            success: false,
            reason: 'self_recipient',
            resolvedChatId: resolved,
            error: `WhatsApp LID recipient ${chatId} resolves to the sending account phone ${accountConfig.phoneNumber}; refusing to send to self.`
          }
        }
        console.log(`[WAHA] resolved LID recipient ${chatId} -> ${resolved}`)
        return { success: true, chatId: resolved }
      }

      return {
        success: false,
        error: `WAHA could not resolve LID recipient ${chatId} to a phone chatId`
      }
    } catch (err) {
      const errMsg = err.response?.data?.message || err.response?.data?.error || err.message
      return {
        success: false,
        error: `WAHA LID recipient resolution failed for ${chatId}: ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`
      }
    }
  }

  async _isSendingAccountChatId(accountConfig, chatId) {
    if (!accountConfig?.phoneNumber || !chatId) return false

    const accountPhone = this._extractDigits(accountConfig.phoneNumber)
    if (!accountPhone) return false

    const normalizedChatId = String(chatId).trim()
    const directPhone = this._extractPhoneFromChatId(normalizedChatId)
    if (directPhone && directPhone === accountPhone) return true

    if (!normalizedChatId.includes('@lid')) return false

    const cacheKey = `${accountConfig.wahaInstanceUrl}|${accountConfig.sessionName}|${normalizedChatId}`
    if (this.selfChatIdCache.has(cacheKey)) {
      return this.selfChatIdCache.get(cacheKey)
    }

    try {
      const response = await axios.get(
        `${accountConfig.wahaInstanceUrl}/api/${accountConfig.sessionName}/lids/${encodeURIComponent(normalizedChatId)}`,
        {
          headers: {
            'X-Api-Key': accountConfig.apiKey,
            'Accept': 'application/json'
          },
          timeout: 5000
        }
      )
      const resolved = response.data?.pn || response.data?.chatId || response.data?.id || null
      const resolvedPhone = this._extractPhoneFromChatId(resolved)
      const isSelf = Boolean(resolvedPhone && resolvedPhone === accountPhone)
      this.selfChatIdCache.set(cacheKey, isSelf)
      return isSelf
    } catch (err) {
      console.warn('[WAHA] self LID check failed:', normalizedChatId, err.response?.data?.message || err.message)
      return false
    }
  }

  _summarizeWahaResponse(data) {
    if (data === null || data === undefined) return String(data)
    if (typeof data === 'string') return data.slice(0, 500)
    try {
      return JSON.stringify(data).slice(0, 500)
    } catch {
      return String(data).slice(0, 500)
    }
  }

  _extractDigits(value) {
    return value ? String(value).replace(/\D/g, '') : ''
  }

  _extractPhoneFromChatId(chatId) {
    if (!chatId || typeof chatId !== 'string') return null
    const match = chatId.trim().match(/^(\d+)@c\.us$/)
    return match ? match[1] : null
  }

  _extensionFromMime(mimeType) {
    const mime = String(mimeType || '').split(';')[0].trim().toLowerCase()
    const map = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/opus': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/wav': '.wav',
      'application/pdf': '.pdf'
    }
    return map[mime] || ''
  }

  _safeIncomingFilename(originalName, mimeType) {
    const parsedExt = path.extname(String(originalName || '')).toLowerCase()
    const ext = parsedExt && !parsedExt.includes('/') && !parsedExt.includes('\\')
      ? parsedExt
      : this._extensionFromMime(mimeType)
    return `incoming-${Date.now()}-${crypto.randomUUID()}${ext || '.bin'}`
  }

  _resolveIncomingMediaUrl(remoteUrl, accountConfig) {
    if (!remoteUrl || typeof remoteUrl !== 'string') return null
    const trimmed = remoteUrl.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('/')) {
      return `${accountConfig.wahaInstanceUrl.replace(/\/$/, '')}${trimmed}`
    }

    return trimmed
  }

  _buildMediaDownloadCandidates(remoteUrl, accountConfig, message = {}) {
    const resolved = this._resolveIncomingMediaUrl(remoteUrl, accountConfig)
    const candidates = resolved ? [resolved] : []

    if (resolved) {
      try {
        const source = new URL(resolved)
        const base = new URL(accountConfig.wahaInstanceUrl)
        if (source.hostname === 'localhost' || source.hostname === '127.0.0.1' || source.hostname === 'host.docker.internal') {
          source.protocol = base.protocol
          source.host = base.host
          const rewritten = source.toString()
          if (!candidates.includes(rewritten)) candidates.push(rewritten)
        }
      } catch {
        // keep the original candidate
      }
    }

    const msgId = message.channelMessageId ? encodeURIComponent(String(message.channelMessageId)) : null
    if (msgId) {
      const baseUrl = accountConfig.wahaInstanceUrl.replace(/\/$/, '')
      const session = encodeURIComponent(accountConfig.sessionName)
      for (const path of [
        `/api/${session}/messages/${msgId}/download`,
        `/api/${session}/messages/${msgId}/media`,
        `/api/${session}/messages/${msgId}/file`
      ]) {
        const url = `${baseUrl}${path}`
        if (!candidates.includes(url)) candidates.push(url)
      }
    }

    return candidates
  }

  async _saveIncomingMediaBuffer(buffer, message, mimeType, originalName) {
    fs.mkdirSync(INCOMING_MEDIA_DIR, { recursive: true })

    const filename = this._safeIncomingFilename(originalName, mimeType)
    const storagePath = path.join(INCOMING_MEDIA_DIR, filename)
    fs.writeFileSync(storagePath, buffer)

    const mediaType = message.messageType || 'file'
    const publicUrl = `${PUBLIC_MEDIA_PREFIX}/${filename}`
    const mediaFileId = crypto.randomUUID()
    const displayName = originalName || filename

    try {
      await sequelize.query(
        `INSERT INTO media_files
          (id, original_name, display_name, description, filename, media_type, mime_type, size, storage_path, url, uploader_id, created_at, updated_at)
         VALUES
          (:id, :originalName, :displayName, :description, :filename, :mediaType, :mimeType, :size, :storagePath, :url, NULL, NOW(), NOW())`,
        {
          replacements: {
            id: mediaFileId,
            originalName: displayName,
            displayName,
            description: 'WhatsApp inbound media',
            filename,
            mediaType,
            mimeType,
            size: buffer.length,
            storagePath,
            url: publicUrl
          }
        }
      )
    } catch (err) {
      console.warn('[WAHA] inbound 媒体文件记录入库失败，不影响消息展示:', err.message)
    }

    return { mediaFileId, publicUrl, filename, size: buffer.length }
  }

  async _downloadIncomingMedia(message, accountId) {
    const content = message?.content || {}
    if (!content.hasMedia) return message

    const mimeType = content.mimeType || content.mimetype || 'application/octet-stream'
    const originalName = content.fileName || content.filename || `${message.messageType || 'media'}`

    try {
      let buffer = null
      if (content.mediaData) {
        const base64 = String(content.mediaData).replace(/^data:[^;]+;base64,/, '')
        buffer = Buffer.from(base64, 'base64')
      } else {
        const accountConfig = await this._getAccountConfig(accountId || message.accountId)
        const candidates = this._buildMediaDownloadCandidates(content.remoteUrl || content.fileUrl, accountConfig, message)
        let lastError = null
        for (const url of candidates) {
          try {
            const response = await axios.get(url, {
              responseType: 'arraybuffer',
              headers: {
                'X-Api-Key': accountConfig.apiKey,
                Accept: '*/*'
              },
              timeout: 30000
            })
            buffer = Buffer.from(response.data)
            break
          } catch (err) {
            lastError = err
          }
        }
        if (!buffer && lastError) throw lastError
      }

      if (!buffer || buffer.length === 0) {
        throw new Error('empty media payload')
      }

      const saved = await this._saveIncomingMediaBuffer(buffer, message, mimeType, originalName)
      message.content = {
        ...content,
        fileUrl: saved.publicUrl,
        url: saved.publicUrl,
        fileName: originalName,
        filename: saved.filename,
        mimeType,
        size: saved.size,
        mediaFileId: saved.mediaFileId,
        mediaData: undefined
      }
    } catch (err) {
      message.content = {
        ...content,
        mediaData: undefined,
        downloadStatus: 'failed',
        downloadError: err.response?.data?.message || err.message
      }
      console.warn('[WAHA] inbound 媒体下载失败:', err.message)
    }

    return message
  }

  _extractChannelMessageId(data) {
    const rawId = data?.id || data?.messageId || data?.key || null
    if (!rawId) return null
    if (typeof rawId === 'string') return rawId
    if (typeof rawId === 'number') return String(rawId)
    if (typeof rawId === 'object') {
      return rawId._serialized || rawId.id || rawId.messageId || rawId.key?.id || JSON.stringify(rawId)
    }
    return String(rawId)
  }

  _resolveLocalMediaPath(fileUrl) {
    if (!fileUrl || typeof fileUrl !== 'string') return null

    const staticPrefix = '/api/media-files/static/'
    let pathname = fileUrl
    try {
      if (/^https?:\/\//i.test(fileUrl)) {
        pathname = new URL(fileUrl).pathname
      }
    } catch {
      pathname = fileUrl
    }

    if (!pathname.startsWith(staticPrefix)) return null

    const filename = decodeURIComponent(pathname.slice(staticPrefix.length))
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null

    const mediaDir = path.join(__dirname, '..', '..', '..', 'public', 'media-files')
    return path.join(mediaDir, filename)
  }

  _buildFilePayload(fileUrl, filename, mimetype) {
    const localPath = this._resolveLocalMediaPath(fileUrl)
    if (localPath && fs.existsSync(localPath)) {
      return {
        mimetype,
        filename,
        data: fs.readFileSync(localPath).toString('base64')
      }
    }

    return {
      mimetype,
      filename,
      url: fileUrl
    }
  }

  _buildSendRequest(accountConfig, targetUserId, messageType, content) {
    if (messageType === 'text') {
      const text = content?.text || content?.content || (typeof content === 'string' ? content : '')
      if (!text) {
        return { success: false, error: '消息内容为空' }
      }
      return {
        success: true,
        url: `${accountConfig.wahaInstanceUrl}/api/sendText`,
        body: {
          session: accountConfig.sessionName,
          chatId: targetUserId,
          text
        }
      }
    }

    if (!['image', 'video', 'audio', 'file'].includes(messageType)) {
      return { success: false, error: `暂不支持的消息类型: ${messageType}` }
    }

    const fileUrl = content?.fileUrl || content?.url
    const filename = content?.fileName || content?.filename || 'file'
    const mimetype = content?.mimeType || content?.mimetype || 'application/octet-stream'
    const caption = content?.caption || content?.text || ''

    if (!fileUrl) {
      return { success: false, error: '文件 URL 不能为空' }
    }

    const endpoint = messageType === 'image'
      ? 'sendImage'
      : (messageType === 'video' ? 'sendVideo' : 'sendFile')

    const body = {
      session: accountConfig.sessionName,
      chatId: targetUserId,
      file: this._buildFilePayload(fileUrl, filename, mimetype),
      caption
    }

    if (messageType === 'video') {
      body.convert = Boolean(content?.convert)
      body.asNote = Boolean(content?.asNote)
    }

    return {
      success: true,
      url: `${accountConfig.wahaInstanceUrl}/api/${endpoint}`,
      body
    }
  }

  /**
   * 绑定账号（暂时简单返回成功）
   * TODO: 后续增加 WAHA 实例健康检查
   */
  async bindAccount(config) {
    try {
      // TODO: 调用 WAHA /api/sessions/{session} 检查 session 是否已启动
      return { success: true }
    } catch (err) {
      console.error('[WAHA] bindAccount 失败:', err.message)
      return { success: false, error: err.message }
    }
  }

  /**
   * 解绑账号
   */
  async unbindAccount(accountId) {
    try {
      // TODO: 调用 WAHA logout session
      return { success: true }
    } catch (err) {
      console.error('[WAHA] unbindAccount 失败:', err.message)
      return { success: false }
    }
  }

  /**
   * 从数据库获取账号配置（兼容明文 JSON 与加密字符串）
   * @private
   */
  async _getAccountConfig(accountId) {
    try {
      const [rows] = await sequelize.query(
        `SELECT config, phone_number FROM channel_accounts WHERE id = :accountId AND status = 'active'`,
        { replacements: { accountId } }
      )

      if (rows.length === 0) {
        // 账号不存在，使用默认配置
        return {
          wahaInstanceUrl: this.baseURL,
          apiKey: this.apiKey,
          sessionName: this.sessionName
        }
      }

      const config = parseWahaAccountConfig(rows[0].config, `accountId=${accountId}`)
      return {
        wahaInstanceUrl: config.wahaInstanceUrl || this.baseURL,
        apiKey: config.apiKey || this.apiKey,
        sessionName: config.sessionName || this.sessionName,
        phoneNumber: rows[0].phone_number || null
      }
    } catch (err) {
      console.error('[WAHA] 获取账号配置失败:', err.message)
      // 降级使用默认配置
      return {
        wahaInstanceUrl: this.baseURL,
        apiKey: this.apiKey,
        sessionName: this.sessionName
      }
    }
  }
}

module.exports = WahaAdapter
