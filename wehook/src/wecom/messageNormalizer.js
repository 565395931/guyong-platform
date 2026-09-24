function text(value) {
  return String(value || '').trim()
}

function normalizeTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now()
  return numeric < 1e12 ? numeric * 1000 : numeric
}

function mediaContent(source = {}, { includeFileName = false } = {}) {
  const mediaId = text(source.media_id || source.mediaId)
  if (!mediaId) return null
  const content = { mediaId }
  if (includeFileName) {
    const fileName = text(source.filename || source.file_name)
    if (fileName) content.fileName = fileName
  }
  return content
}

function normalizeContent(message) {
  switch (message.msgtype) {
    case 'text': {
      const value = text(message.text?.content)
      return value ? { messageType: 'text', content: { text: value } } : null
    }
    case 'image': {
      const content = mediaContent(message.image)
      return content ? { messageType: 'image', content } : null
    }
    case 'voice': {
      const content = mediaContent(message.voice)
      return content ? { messageType: 'audio', content } : null
    }
    case 'video': {
      const content = mediaContent(message.video)
      return content ? { messageType: 'video', content } : null
    }
    case 'file': {
      const content = mediaContent(message.file, { includeFileName: true })
      return content ? { messageType: 'file', content } : null
    }
    case 'link': {
      const url = text(message.link?.url)
      const title = text(message.link?.title)
      const description = text(message.link?.desc || message.link?.description)
      const displayText = title || description || url
      if (!displayText) return null
      return {
        messageType: 'text',
        content: {
          text: displayText,
          title: title || null,
          description: description || null,
          url: url || null,
          thumbUrl: text(message.link?.pic_url) || null,
          wecomMessageType: 'link'
        }
      }
    }
    case 'location': {
      const name = text(message.location?.name)
      const address = text(message.location?.address)
      return {
        messageType: 'text',
        content: {
          text: name || address || '位置消息',
          name: name || null,
          address: address || null,
          latitude: Number(message.location?.latitude),
          longitude: Number(message.location?.longitude),
          wecomMessageType: 'location'
        }
      }
    }
    default:
      return null
  }
}

function normalizeWecomMessage(message, runtimeConfig) {
  if (!message || Number(message.origin) !== 3) return null
  const channelMessageId = text(message.msgid)
  const openKfId = text(message.open_kfid)
  const externalUserId = text(message.external_userid)
  if (!channelMessageId || !openKfId || !externalUserId) return null
  const account = runtimeConfig?.accounts?.find(item => text(item.openKfId) === openKfId)
  if (!account || !Number.isInteger(Number(account.accountId)) || Number(account.accountId) <= 0) return null
  const normalizedContent = normalizeContent(message)
  if (!normalizedContent) return null
  const connectionId = Number(runtimeConfig.connectionId)
  return {
    eventId: `wecom:${connectionId}:${channelMessageId}`,
    payload: {
      channel: 'wecom_kf',
      accountId: Number(account.accountId),
      channelAccountId: openKfId,
      channelUserId: externalUserId,
      direction: 'inbound',
      messageType: normalizedContent.messageType,
      content: normalizedContent.content,
      channelMessageId,
      clientTimestamp: normalizeTimestamp(message.send_time),
      metadata: {
        connectionId,
        openKfId,
        origin: Number(message.origin)
      }
    }
  }
}

module.exports = {
  normalizeContent,
  normalizeTimestamp,
  normalizeWecomMessage
}

