/**
 * WAHA Webhook 消息格式与平台 StandardMessage 的转换
 *
 * WAHA Webhook 事件格式（文本消息示例）：
 * {
 *   "event": "message",
 *   "session": "default",
 *   "payload": {
 *     "id": "wamid.xxx",
 *     "from": "8613800138000@c.us",
 *     "to": "你的号码@c.us",
 *     "body": "你好",
 *     "timestamp": 1650000000
 *   }
 * }
 *
 * 平台 StandardMessage 格式见项目规则文档 5.2 节。
 */

const crypto = require('crypto')

function normalizeChannelMessageId(rawId) {
  if (!rawId) return null
  if (typeof rawId === 'string') return rawId
  if (typeof rawId === 'number') return String(rawId)
  if (typeof rawId === 'object') {
    return rawId._serialized || rawId.id || rawId.messageId || rawId.key?.id || JSON.stringify(rawId)
  }
  return String(rawId)
}

function buildFallbackChannelMessageId(evt = {}, p = {}, text = '', mediaMeta = null) {
  const source = JSON.stringify({
    session: evt.session || null,
    accountId: evt._accountId || null,
    from: p.from || null,
    to: p.to || null,
    timestamp: p.timestamp || null,
    type: p.type || p.messageType || mediaMeta?.rawType || mediaMeta?.type || 'text',
    body: text || '',
    mediaUrl: mediaMeta?.mediaUrl || null,
    fileName: mediaMeta?.fileName || null,
    mimeType: mediaMeta?.mimeType || null
  })
  return `waha-fallback-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 48)}`
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function getBaileysMessage(p = {}) {
  return p.message || p._data?.message || p.raw?.message || {}
}

function extractMessageTextFromBaileys(message = {}) {
  return firstValue(
    message.conversation,
    message.extendedTextMessage?.text,
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption,
    message.buttonsResponseMessage?.selectedDisplayText,
    message.listResponseMessage?.title,
    message.templateButtonReplyMessage?.selectedDisplayText
  ) || ''
}

function extractContextInfo(message = {}) {
  return message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.audioMessage?.contextInfo ||
    message.stickerMessage?.contextInfo ||
    null
}

function extractQuotedTextFromBaileys(quotedMessage = {}) {
  return extractMessageTextFromBaileys(quotedMessage) ||
    quotedMessage.audioMessage?.mimetype ||
    quotedMessage.stickerMessage?.mimetype ||
    ''
}

function extractChatId(p = {}) {
  return firstValue(
    p.from,
    p.chatId,
    p.remoteJid,
    p.key?.remoteJid,
    p._data?.from,
    p._data?.chatId,
    p._data?.remoteJid,
    p._data?.key?.remoteJid
  )
}

function extractChannelAccountId(evt = {}, p = {}) {
  return firstValue(
    p.to,
    p.participant,
    p.key?.participant,
    p._data?.to,
    p._data?.participant,
    p._data?.key?.participant,
    evt.session
  )
}

function isTrueFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function isOutgoingMessagePayload(p = {}) {
  return [
    p.fromMe,
    p.id?.fromMe,
    p.key?.fromMe,
    p._data?.fromMe,
    p._data?.id?.fromMe,
    p._data?.key?.fromMe
  ].some(isTrueFlag)
}

function detectMediaType({ mimeType, rawType }) {
  const mime = String(mimeType || '').toLowerCase()
  const type = String(rawType || '').toLowerCase()

  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (['image', 'sticker'].includes(type)) return 'image'
  if (type === 'video') return 'video'
  if (['audio', 'ptt', 'voice'].includes(type)) return 'audio'
  if (['document', 'file'].includes(type)) return 'file'
  return 'file'
}

function isMediaRawType(rawType) {
  return ['image', 'sticker', 'video', 'audio', 'ptt', 'voice', 'document', 'file'].includes(String(rawType || '').toLowerCase())
}

function normalizeAccountId(value) {
  if (value === undefined || value === null || value === '') return null
  return value
}

function normalizeTimestamp(value) {
  if (!value) return Date.now()
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return numeric < 1000000000000 ? numeric * 1000 : numeric
  }
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function findBaileysMessageType(message = {}) {
  if (!message || typeof message !== 'object') return null
  if (message.imageMessage) return 'image'
  if (message.videoMessage) return 'video'
  if (message.audioMessage) return 'audio'
  if (message.documentMessage) return 'document'
  if (message.stickerMessage) return 'sticker'
  return null
}

function extractNestedMedia(p = {}) {
  const candidates = [
    p.media,
    p.file,
    p.image,
    p.video,
    p.audio,
    p.document,
    p.attachment,
    p._data?.media,
    p._data?.file,
    p._data?.message?.imageMessage,
    p._data?.message?.videoMessage,
    p._data?.message?.audioMessage,
    p._data?.message?.documentMessage,
    p._data?.message?.stickerMessage
  ]

  return candidates.find(item => item && typeof item === 'object') || {}
}

function extractMediaMeta(p = {}) {
  const nested = extractNestedMedia(p)
  const message = getBaileysMessage(p)
  const rawType = firstValue(
    p.type,
    p.messageType,
    p._data?.type,
    findBaileysMessageType(message)
  )
  const mimeType = firstValue(
    p.mimeType,
    p.mimetype,
    p.mime,
    nested.mimeType,
    nested.mimetype,
    nested.mime,
    p._data?.mimeType,
    p._data?.mimetype
  )
  const mediaUrl = firstValue(
    p.mediaUrl,
    p.downloadUrl,
    p.fileUrl,
    nested.url,
    nested.fileUrl,
    nested.downloadUrl,
    nested.mediaUrl,
    p.url
  )
  const mediaData = firstValue(nested.data, nested.base64, p.mediaData, p.data, p.base64)
  const fileName = firstValue(
    p.fileName,
    p.filename,
    nested.fileName,
    nested.filename,
    nested.file_name,
    p._data?.filename,
    `${rawType || 'media'}-${Date.now()}`
  )

  if (!p.hasMedia && !mediaUrl && !mediaData && !mimeType && !isMediaRawType(rawType)) {
    return null
  }

  return {
    type: detectMediaType({ mimeType, rawType }),
    rawType,
    mimeType: mimeType || 'application/octet-stream',
    fileName,
    mediaUrl,
    mediaData
  }
}

/**
 * 将 WAHA Webhook payload 转换为 StandardMessage 数组
 *
 * @param {Object|Array} payload - WAHA Webhook 的 body（单个事件对象或数组）
 * @param {number} accountId - 平台渠道账号 ID
 * @returns {Array<Object>} StandardMessage[]
 */
function toStandardMessages(payload, accountId) {
  try {
    // WAHA 可能推送单个对象或数组
    const events = Array.isArray(payload) ? payload : [payload]
    const messages = []

    for (const evt of events) {
      // 只处理 message 事件，其他事件（status、qrcode 等）暂不处理
      if (evt.event !== 'message') {
        continue
      }

      const p = evt.payload || {}
      const baileysMessage = getBaileysMessage(p)
      const eventAccountId = normalizeAccountId(firstValue(evt._accountId, accountId))
      const chatId = extractChatId(p)
      let text = p.body || p.text || p.caption || extractMessageTextFromBaileys(baileysMessage)
      const mediaMeta = extractMediaMeta(p)

      // 暂时只处理文本消息，其他类型留空
      if (!text && !mediaMeta) {
        continue
      }

      // 过滤 outgoing 消息：WAHA 的 message 事件同时推送 incoming 和 outgoing，
      // outgoing 消息的 _data.id.fromMe === true。如果不跳过，会导致账号自己发的消息
      // 被当成"客户发来的 inbound 消息"创建幽灵会话。
      if (isOutgoingMessagePayload(p)) {
        console.log('[WAHAFormat] 跳过 outgoing 消息, from:', p.from)
        continue
      }

      // 处理引用回复（quoted reply）：将引用文本作为上下文保留在 content 中
      // WAHA 字段名为 replyTo（非 quotedMsg），包含 { id, body, participant, _data }
      // ReplyToMessage 没有 from 字段，尝试从 _data 中提取发送者
      let quotedContext = null
      if (p.replyTo) {
        console.log('[WAHAFormat] 检测到引用回复, replyTo keys:', Object.keys(p.replyTo), 'body:', p.replyTo.body?.substring(0, 100), '_data keys:', p.replyTo._data ? Object.keys(p.replyTo._data) : 'none')
        const quotedBody = p.replyTo.body || ''
        if (quotedBody) {
          const from = p.replyTo._data?.from || p.replyTo._data?.author
            || p.replyTo.participant || null
          quotedContext = {
            text: quotedBody,
            from
          }
          // 如果 body 中包含了引用原文（某些引擎会拼接），去除重复部分
          // 常见格式: "引用文本\n\n回复文本" 或 "[引用] 引用文本\n回复文本"
          if (text.startsWith(quotedBody)) {
            text = text.substring(quotedBody.length).trim()
            // 去除前导的换行符或分隔符
            text = text.replace(/^[\n\r\s>…\-—]+/, '').trim()
          }
        }
      }
      const contextInfo = extractContextInfo(baileysMessage)
      if (!quotedContext && contextInfo?.quotedMessage) {
        const quotedText = extractQuotedTextFromBaileys(contextInfo.quotedMessage)
        if (quotedText) {
          quotedContext = {
            text: quotedText,
            from: contextInfo.participant || null,
            id: contextInfo.stanzaId || null
          }
        }
      }

      const channelMessageId = normalizeChannelMessageId(p.id || p._data?.id) ||
        buildFallbackChannelMessageId(evt, p, text, mediaMeta)
      const rawTimestamp = firstValue(p.timestamp, p.messageTimestamp, p._data?.timestamp, p._data?.messageTimestamp)

      const standardMessage = {
        id: crypto.randomUUID(),
        channel: 'whatsapp',
        accountId: eventAccountId,
        channelAccountId: extractChannelAccountId(evt, p),
        userId: null, // 由 messagingService 补充
        channelUserId: chatId,
        conversationId: null, // 由 messagingService 补充
        direction: 'inbound',
        messageType: mediaMeta?.type || 'text',
        content: {
          text: text,
          ...(mediaMeta ? {
            hasMedia: true,
            rawType: mediaMeta.rawType || null,
            mimeType: mediaMeta.mimeType,
            fileName: mediaMeta.fileName,
            remoteUrl: mediaMeta.mediaUrl || null,
            fileUrl: mediaMeta.mediaUrl || null,
            mediaData: mediaMeta.mediaData || null,
            transcriptionStatus: mediaMeta.type === 'audio' ? 'not_started' : undefined
          } : {}),
          ...(quotedContext ? { quotedMsg: quotedContext } : {})
        },
        channelMessageId,
        clientTimestamp: normalizeTimestamp(rawTimestamp),
        serverTimestamp: Date.now()
      }

      messages.push(standardMessage)
    }

    return messages
  } catch (err) {
    console.error('[WAHAFormat] 转换消息失败:', err.message)
    return []
  }
}

module.exports = { toStandardMessages }
