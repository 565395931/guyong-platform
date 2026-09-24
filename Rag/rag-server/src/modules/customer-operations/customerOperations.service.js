const { localDateKey, buildVisibilityPredicate } = require('./communicationRules')
const { createCustomerOperationsRepository } = require('./customerOperations.repository')

const WON_STATUSES = new Set(['paid', 'delivered', 'closed'])
const CANCELLED_STATUSES = new Set(['cancelled', 'refunded'])

function toDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date value')
  return date
}

function toMysqlDateTime(value) {
  const date = toDate(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function addDays(value, days) {
  const date = toDate(value)
  date.setUTCDate(date.getUTCDate() + Number(days))
  return date
}

function createCustomerOperationsService({
  repository = createCustomerOperationsRepository(),
  now = () => new Date(),
  timeZone = process.env.APP_TIMEZONE || 'Asia/Shanghai',
  firstFollowupDays = 10,
  secondFollowupDays = 15
} = {}) {
  async function recordMessage(message = {}) {
    const senderType = message.senderType || (message.direction === 'inbound' ? 'customer' : 'agent')
    const isCustomerMessage = message.direction === 'inbound' && senderType === 'customer'
    const isAgentMessage = message.direction === 'outbound' && senderType === 'agent'
    if (!isCustomerMessage && !isAgentMessage) return { ignored: true }

    const timestamp = message.timestamp || message.createdAt || now()
    const date = toDate(timestamp)
    const identity = await repository.findOrCreateCustomerIdentity({
      channel: message.channel,
      accountId: message.accountId,
      externalUserId: message.externalUserId || message.channelUserId || message.userId,
      phone: message.phone || message.customerPhone,
      displayName: message.displayName || message.userName
    })
    const communicationDate = localDateKey(date, timeZone)
    await repository.upsertCommunicationDay({
      customerId: identity.customerId,
      communicationDate,
      messageCountDelta: 1,
      firstMessageAt: toMysqlDateTime(date),
      lastMessageAt: toMysqlDateTime(date),
      ownerId: message.ownerId ?? message.agentId ?? message.claimedBy ?? null,
      conversationId: message.conversationId || null
    })
    await repository.resequenceCommunicationStages(identity.customerId)
    await repository.markAiRecomputeNeeded?.(identity.customerId)
    return { customerId: identity.customerId, communicationDate, ignored: false }
  }

  async function applyOrderStatus(order = {}) {
    const status = String(order.status || '').toLowerCase()
    if (!WON_STATUSES.has(status) && !CANCELLED_STATUSES.has(status)) return { ignored: true }

    const customer = order.customer || {}
    const identity = await repository.findOrCreateCustomerIdentity({
      channel: order.channel || 'order',
      accountId: order.accountId,
      externalUserId: order.externalUserId || order.channelUserId || customer.phone || customer.email || order.orderId,
      phone: customer.phone || order.customerPhone,
      displayName: customer.name || order.customerName
    })

    if (CANCELLED_STATUSES.has(status)) {
      await repository.cancelPendingOrderFollowups?.(order.orderId)
      return { customerId: identity.customerId, cancelled: true }
    }

    const wonAt = order.wonAt || order.paidAt || order.updatedAt || now()
    await repository.markCustomerWon({ customerId: identity.customerId, wonAt, orderId: order.orderId })
    await repository.createWonFollowupIfMissing({
      customerId: identity.customerId,
      orderId: order.orderId,
      conversationId: order.conversationId || order.sourceConversationId,
      type: 'won_first',
      assignedTo: order.ownerId || order.ownerSeatId || null,
      dueAt: toMysqlDateTime(addDays(wonAt, firstFollowupDays)),
      source: 'fallback',
      aiReason: '成交后的默认首次复联时间，等待 AI 根据沟通内容重新评估',
      aiConfidence: null,
      aiSignals: []
    })
    await repository.markAiRecomputeNeeded?.(identity.customerId)
    return { customerId: identity.customerId, won: true }
  }

  function getVisibleCustomerScope(user) {
    return buildVisibilityPredicate(user, 'c')
  }

  return {
    recordMessage,
    applyOrderStatus,
    getVisibleCustomerScope,
    firstFollowupDays,
    secondFollowupDays
  }
}

module.exports = {
  createCustomerOperationsService,
  WON_STATUSES,
  CANCELLED_STATUSES,
  toMysqlDateTime,
  addDays
}
