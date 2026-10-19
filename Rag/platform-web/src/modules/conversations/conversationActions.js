export function isArchivedConversation(conversation) {
  return conversation?.conv_status === 'archived' || conversation?.status === 'closed' || conversation?.pool_type === 'archived'
}

export function canReleaseConversation(conversation) {
  return !isArchivedConversation(conversation) && ['private', 'long_term'].includes(conversation?.pool_type)
}
