export function isMine(conversation, user = {}) {
  return conversation?.is_mine === true || Number(conversation?.is_mine) === 1
    || Number(conversation?.claimed_by) === Number(user.id)
    || conversation?.participant_seat_ids?.map(Number).includes(Number(user.id))
}
export function isArchived(conversation) {
  return conversation?.conv_status === 'archived' || conversation?.status === 'closed' || conversation?.pool_type === 'archived'
}
export function fitsWorkspaceTab(conversation, tab, user = {}) {
  if (tab === 'all') return true
  if (tab === 'archived') return isArchived(conversation)
  if (isArchived(conversation)) return false
  if (tab === 'private') return isMine(conversation, user) || (user.role === 'admin' && ['private', 'long_term'].includes(conversation?.pool_type))
  if (tab === 'pending_human') return conversation?.pool_type === tab && (user.role === 'admin' || Number(conversation?.agent_id) === Number(user.id))
  return conversation?.pool_type === tab
}
