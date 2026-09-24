function createDouyinWebhookHandler({
  loadAccount,
  adapter,
  getAdapter,
  eventInbox,
  schedule = task => setImmediate(() => task()),
  logger = console
}) {
  return async function handleDouyinWebhook(req, res) {
    const accountId = Number(req.query?.account_id)
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ code: 400, msg: 'account_id required' })
    }

    try {
      const account = await loadAccount(accountId)
      if (!account || account.channel !== 'douyin' || account.status !== 'active') {
        return res.status(404).json({ code: 404, msg: 'account not found' })
      }
      const activeAdapter = adapter || getAdapter?.()
      if (!activeAdapter) return res.status(503).json({ code: 503, msg: 'adapter unavailable' })

      activeAdapter.verifyWebhook({ headers: req.headers || {}, rawBody: req.rawBody, config: account.config })
      const receivedEvents = activeAdapter.receiveBusinessEvents(req.body, { accountId })
      activeAdapter.verifyBusinessEventScope(receivedEvents, { config: account.config })
      const events = receivedEvents.filter(event => event.category !== 'probe')

      res.json({ code: 0, msg: 'success' })
      schedule(async () => {
        for (const event of events) {
          try {
            const result = await eventInbox.store(event)
            logger.info?.('douyin.event_stored', {
              accountId,
              externalEventId: event.externalEventId,
              category: event.category,
              duplicate: result.duplicate
            })
          } catch (error) {
            logger.error?.('douyin.event_store_failed', {
              accountId,
              externalEventId: event.externalEventId,
              error
            })
          }
        }
      })
      return res
    } catch (error) {
      logger.warn?.('douyin.webhook_rejected', { accountId, code: error.code || 'invalid_webhook' })
      if (error.code === 'douyin_signature_invalid' || error.code === 'douyin_app_id_mismatch') {
        return res.status(401).json({ code: 401, msg: 'invalid signature' })
      }
      if (error.code === 'douyin_shop_id_mismatch') {
        return res.status(409).json({
          code: 'douyin_shop_id_mismatch',
          msg: 'event does not match account'
        })
      }
      return res.status(400).json({ code: 400, msg: 'invalid webhook' })
    }
  }
}

module.exports = { createDouyinWebhookHandler }
