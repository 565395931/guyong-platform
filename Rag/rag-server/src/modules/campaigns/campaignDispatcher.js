function createCampaignDispatcher({ repository, adapterResolver, logger = console } = {}) {
  if (!repository) throw new Error('Campaign repository is required')
  if (typeof adapterResolver !== 'function') throw new Error('adapterResolver is required')

  let timer = null

  async function runOnce() {
    const delivery = await repository.claimNextDelivery()
    if (!delivery) return { status: 'idle' }

    const quotaReserved = await repository.reserveAccountQuota(delivery.accountId)
    if (!quotaReserved) {
      await repository.deferDelivery(delivery.id, '账号今日额度已用尽')
      await repository.refreshTaskCounts(delivery.taskId)
      return { status: 'deferred', deliveryId: delivery.id }
    }

    try {
      const adapter = adapterResolver(delivery.channel || delivery.adapterType)
      if (!adapter || typeof adapter.sendMessage !== 'function') {
        throw new Error('未找到可用渠道适配器')
      }

      const result = await adapter.sendMessage(delivery.accountId, delivery.userId, delivery.message)
      if (!result || result.success === false) {
        throw new Error(result?.error || '渠道发送失败')
      }

      await repository.completeDelivery(delivery.id, {
        channelMessageId: result.channelMsgId || result.channelMessageId || null
      })
      await repository.refreshTaskCounts(delivery.taskId)
      return { status: 'success', deliveryId: delivery.id }
    } catch (error) {
      logger.error('[CampaignDispatcher] delivery failed', {
        deliveryId: delivery.id,
        taskId: delivery.taskId,
        error: error.message
      })
      await repository.failDelivery(delivery.id, error.message)
      await repository.refreshTaskCounts(delivery.taskId)
      return { status: 'failed', deliveryId: delivery.id, error: error.message }
    }
  }

  function start({ intervalMs = 2000 } = {}) {
    if (timer) return api
    timer = setInterval(() => {
      runOnce().catch(error => logger.error('[CampaignDispatcher] loop error', { error: error.message }))
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return api
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  const api = {
    runOnce,
    start,
    stop,
    isRunning: () => Boolean(timer)
  }

  return api
}

module.exports = {
  createCampaignDispatcher
}
