export function isWhatsAppGroupConversation(conversation) {
  return conversation?.channel === 'whatsapp' &&
    typeof conversation?.user_id === 'string' &&
    conversation.user_id.trim().endsWith('@g.us')
}

export function getConversationDisplayName(conversation) {
  if (!conversation) return '未知用户'

  if (isWhatsAppGroupConversation(conversation)) {
    const userId = String(conversation.user_id || '').trim()
    const groupId = userId.replace(/@g\.us$/i, '')
    const rawName = String(conversation.user_name || '').trim()

    if (rawName && rawName !== userId && rawName !== groupId) {
      return rawName
    }

    return groupId ? `WhatsApp 群聊 ${groupId.slice(-6)}` : 'WhatsApp 群聊'
  }

  return conversation.user_name || conversation.customer_phone || conversation.user_id || '未知用户'
}

export function getConversationAvatarText(conversation) {
  if (isWhatsAppGroupConversation(conversation)) return '群'
  return getConversationDisplayName(conversation).charAt(0) || '?'
}

export function getConversationIdLabel(conversation) {
  return isWhatsAppGroupConversation(conversation) ? '群聊ID' : '渠道用户ID'
}
