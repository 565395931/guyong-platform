function toMysqlUtc(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid follow-up date')
  const pad = number => String(number).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function buildNextFollowup(completedTask = {}, completedAt = new Date(), secondFollowupDays = 15) {
  if (completedTask.type !== 'won_first') return null
  const dueAt = new Date(completedAt)
  if (Number.isNaN(dueAt.getTime())) throw new TypeError('Invalid completion date')
  dueAt.setUTCDate(dueAt.getUTCDate() + Number(secondFollowupDays))

  return {
    customerId: completedTask.customerId || completedTask.customer_id,
    orderId: completedTask.orderId || completedTask.order_id,
    conversationId: completedTask.conversationId || completedTask.conversation_id || null,
    type: 'won_second',
    assignedTo: completedTask.assignedTo ?? completedTask.assigned_to ?? null,
    dueAt: toMysqlUtc(dueAt),
    source: 'fallback',
    aiReason: '首次复联完成后的默认二次复联时间，等待 AI 根据最新沟通重新评估',
    aiSignals: []
  }
}

module.exports = { buildNextFollowup, toMysqlUtc }
