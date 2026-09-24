const SUPPORTED_TYPES = new Set(['dm', 'comment', 'keyword'])
const SUPPORTED_CHANNELS = new Set([
  'whatsapp',
  'wechat',
  'wecom_kf',
  'douyin',
  'pinduoduo',
  'taobao',
  'alibaba1688',
  'xiaohongshu',
  'wechat_shop',
  'kuaishou'
])

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))]
}

function normalizeScripts(scripts = []) {
  return (Array.isArray(scripts) ? scripts : [])
    .map(script => ({
      content: String(script?.content || '').trim(),
      mediaFileIds: uniqueStrings(script?.mediaFileIds)
    }))
    .filter(script => script.content)
}

function normalizeCampaignInput(input = {}) {
  const name = String(input.name || '').trim()
  if (!name) return { error: '任务名称不能为空' }
  if (name.length > 120) return { error: '任务名称不能超过120个字符' }

  const type = String(input.type || '').trim().toLowerCase()
  if (!SUPPORTED_TYPES.has(type)) return { error: '不支持的任务类型' }

  const targetChannels = uniqueStrings(input.targetChannels)
  if (targetChannels.length === 0) return { error: '至少选择一个目标渠道' }
  if (targetChannels.some(channel => !SUPPORTED_CHANNELS.has(channel))) {
    return { error: '包含不支持的目标渠道' }
  }

  const targetTags = uniqueStrings(input.targetTags)
  const targetUserIds = uniqueStrings(input.targetUserIds)
  if (targetTags.length === 0 && targetUserIds.length === 0) {
    return { error: '至少提供一个目标用户或目标标签' }
  }

  const scripts = normalizeScripts(input.scripts)
  if (scripts.length === 0) return { error: '至少填写一组发送话术' }
  if (scripts.some(script => script.content.length > 4000)) {
    return { error: '单组话术不能超过4000个字符' }
  }

  const dailyLimit = Number(input.dailyLimit ?? 100)
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) {
    return { error: '每日上限必须是1到1000之间的整数' }
  }

  const intervalSeconds = Number(input.intervalSeconds ?? input.interval ?? 30)
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) {
    return { error: '发送间隔必须是5到3600秒之间的整数' }
  }

  const accountIds = [...new Set((Array.isArray(input.accountIds) ? input.accountIds : [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0))]

  return {
    data: {
      name,
      type,
      targetTags,
      targetChannels,
      targetUserIds,
      scripts,
      accountIds,
      dailyLimit,
      intervalSeconds,
      sendTimeStart: String(input.sendTimeStart || '').trim() || null,
      sendTimeEnd: String(input.sendTimeEnd || '').trim() || null
    }
  }
}

function renderScript(template, variables = {}) {
  return String(template || '').replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const key = String(rawKey || '').trim()
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key] ?? '')
      : match
  })
}

function accountCapacity(account, dailyLimit) {
  const maxDailyQuota = Math.max(0, Number(account.maxDailyQuota ?? account.max_daily_quota ?? dailyLimit) || 0)
  const dailyQuota = Math.max(0, Number(account.dailyQuota ?? account.daily_quota ?? 0) || 0)
  return Math.max(0, Math.min(dailyLimit, maxDailyQuota) - dailyQuota)
}

function findAccount(accounts, capacityById, channel, startIndex) {
  const channelAccounts = accounts.filter(account => account.channel === channel)
  if (channelAccounts.length === 0) return null

  for (let offset = 0; offset < channelAccounts.length; offset += 1) {
    const index = (startIndex + offset) % channelAccounts.length
    const account = channelAccounts[index]
    if ((capacityById[account.id] || 0) > 0) return account
  }
  return null
}

function buildDispatchPlan({ targets = [], accounts = [], config = {}, now = new Date() } = {}) {
  const intervalSeconds = Math.max(5, Number(config.intervalSeconds || 30))
  const scripts = normalizeScripts(config.scripts)
  if (scripts.length === 0) return []

  const activeAccounts = accounts
    .filter(account => account && account.status === 'active')
    .map(account => ({ ...account, channel: String(account.channel || '').toLowerCase() }))
  const initialCapacity = Object.fromEntries(activeAccounts.map(account => [
    account.id,
    accountCapacity(account, Number(config.dailyLimit || 100))
  ]))

  return targets.reduce((state, target) => {
    const channel = String(target?.channel || '').toLowerCase()
    const account = findAccount(activeAccounts, state.capacityById, channel, state.cursorByChannel[channel] || 0)
    if (!account || !target?.userId) return state

    const script = scripts[state.plan.length % scripts.length]
    const scheduledAt = new Date(now.getTime() + (state.plan.length * intervalSeconds * 1000)).toISOString()
    const variables = {
      ...target.variables,
      name: target.name || target.displayName || '',
      userId: target.userId,
      channel
    }
    const channelAccountCount = activeAccounts.filter(item => item.channel === channel).length

    return {
      plan: [
        ...state.plan,
        {
          accountId: account.id,
          channel,
          userId: target.userId,
          scheduledAt,
          message: {
            messageType: 'text',
            content: { text: renderScript(script.content, variables) }
          },
          mediaFileIds: [...script.mediaFileIds]
        }
      ],
      capacityById: {
        ...state.capacityById,
        [account.id]: state.capacityById[account.id] - 1
      },
      cursorByChannel: {
        ...state.cursorByChannel,
        [channel]: channelAccountCount > 0
          ? ((state.cursorByChannel[channel] || 0) + 1) % channelAccountCount
          : 0
      }
    }
  }, { plan: [], capacityById: initialCapacity, cursorByChannel: {} }).plan
}

module.exports = {
  SUPPORTED_TYPES,
  SUPPORTED_CHANNELS,
  normalizeCampaignInput,
  renderScript,
  buildDispatchPlan
}

