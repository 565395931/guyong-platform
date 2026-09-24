const crypto = require('crypto')
const { buildDispatchPlan, normalizeCampaignInput } = require('./campaignPlan')

function createHttpError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function actorIdFromUser(user = {}) {
  return user.id || user.userId || null
}

function createCampaignService({ repository, idFactory = crypto.randomUUID, now = () => new Date() } = {}) {
  if (!repository) {
    throw new Error('Campaign repository is required')
  }

  async function create(input, user = {}) {
    const parsed = normalizeCampaignInput(input)
    if (parsed.error) throw createHttpError(parsed.error, 400)

    const targets = await repository.resolveTargets(parsed.data)
    if (!targets.length) {
      throw createHttpError('没有匹配的目标用户', 409)
    }

    const accounts = await repository.listActiveAccounts(parsed.data)
    const plan = buildDispatchPlan({
      targets,
      accounts,
      config: parsed.data,
      now: now()
    })

    if (!plan.length) {
      throw createHttpError('没有可用账号或账号额度不足', 409)
    }

    const taskId = idFactory()
    const task = {
      id: taskId,
      name: parsed.data.name,
      type: parsed.data.type,
      targetTags: [...parsed.data.targetTags],
      targetChannels: [...parsed.data.targetChannels],
      targetUserIds: [...parsed.data.targetUserIds],
      accountIds: [...parsed.data.accountIds],
      scripts: parsed.data.scripts.map(script => ({ ...script, mediaFileIds: [...script.mediaFileIds] })),
      dailyLimit: parsed.data.dailyLimit,
      intervalSeconds: parsed.data.intervalSeconds,
      sendTimeStart: parsed.data.sendTimeStart,
      sendTimeEnd: parsed.data.sendTimeEnd,
      status: 'running',
      totalCount: plan.length,
      pendingCount: plan.length,
      successCount: 0,
      failedCount: 0,
      createdBy: actorIdFromUser(user)
    }

    const deliveries = plan.map(item => ({
      id: idFactory(),
      taskId,
      accountId: item.accountId,
      channel: item.channel,
      userId: item.userId,
      scheduledAt: item.scheduledAt,
      message: { ...item.message, content: { ...item.message.content } },
      mediaFileIds: [...item.mediaFileIds],
      status: 'scheduled'
    }))

    return repository.createTaskWithDeliveries({ task, deliveries })
  }

  return { create }
}

module.exports = {
  createCampaignService
}
