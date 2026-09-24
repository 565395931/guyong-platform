const { WON_STATUSES, CANCELLED_STATUSES } = require('./customerOperations.service')

function createCustomerOperationsEventHooks({ service, eventsRepository = null, logger = console } = {}) {
  if (!service) throw new Error('customer operations service is required')

  async function recordMessage(message = {}) {
    const senderType = message.senderType || (message.direction === 'inbound' ? 'customer' : 'agent')
    const shouldRecord = (
      message.direction === 'inbound' && senderType === 'customer'
    ) || (
      message.direction === 'outbound' && senderType === 'agent'
    )
    if (!shouldRecord) return { ignored: true }

    try {
      if (eventsRepository) {
        const messageKey = message.messageId || message.channelMessageId || `${message.conversationId}:${message.timestamp || Date.now()}`
        await eventsRepository.enqueue({
          eventKey: `message:${messageKey}:${message.direction}`,
          eventType: 'message.recorded',
          payload: { messageId: message.messageId || null, channelMessageId: message.channelMessageId || null, conversationId: message.conversationId || null, channel: message.channel || null, accountId: message.accountId ?? null, direction: message.direction, senderType }
        })
      }
      return await service.recordMessage({ ...message, senderType })
    } catch (error) {
      logger.error?.('[CustomerOperations] message analytics failed:', error.message)
      return { ignored: true, error: error.message }
    }
  }

  async function recordOrderStatus(order = {}) {
    const status = String(order.status || '').toLowerCase()
    if (!WON_STATUSES.has(status) && !CANCELLED_STATUSES.has(status)) return { ignored: true }
    try {
      if (eventsRepository) {
        await eventsRepository.enqueue({
          eventKey: `order:${order.orderId}:${status}`,
          eventType: 'order.status_changed',
          payload: { orderId: order.orderId, customerId: order.customerId || null, status }
        })
      }
      return await service.applyOrderStatus({ ...order, status })
    } catch (error) {
      logger.error?.('[CustomerOperations] order analytics failed:', error.message)
      return { ignored: true, error: error.message }
    }
  }

  return { recordMessage, recordOrderStatus }
}

module.exports = { createCustomerOperationsEventHooks }
