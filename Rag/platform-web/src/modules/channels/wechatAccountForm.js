const cleanText = value => typeof value === 'string' ? value.trim() : ''

export function normalizeWechatAccountForm(input = {}) {
  const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
  return {
    accountName: cleanText(input.accountName ?? input.account_name),
    appId: cleanText(input.appId),
    appSecret: cleanText(input.appSecret),
    maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
  }
}

export function validateWechatAccountForm(input = {}) {
  const form = normalizeWechatAccountForm(input)
  const errors = []
  if (!form.accountName) errors.push('账号名称不能为空')
  if (!form.appId) errors.push('App ID 不能为空')
  if (!form.appSecret) errors.push('App Secret 不能为空')
  return errors
}

export function buildWechatAccountCreateRequest(input = {}) {
  const form = normalizeWechatAccountForm(input)
  return {
    channel: 'wechat',
    account_name: form.accountName,
    adapter_type: 'wechat_mini_program',
    max_daily_quota: form.maxDailyQuota,
    config: {
      appId: form.appId,
      appSecret: form.appSecret
    }
  }
}
