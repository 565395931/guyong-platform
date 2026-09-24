const cleanText = value => typeof value === 'string' ? value.trim() : ''

export function normalizeDouyinAccountForm(input = {}) {
  const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
  return {
    accountName: cleanText(input.accountName ?? input.account_name),
    appKey: cleanText(input.appKey),
    appSecret: cleanText(input.appSecret),
    shopId: cleanText(input.shopId),
    maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
  }
}

export function validateDouyinAccountForm(input = {}) {
  const form = normalizeDouyinAccountForm(input)
  const errors = []
  if (!form.accountName) errors.push('账号名称不能为空')
  if (!form.appKey) errors.push('App Key 不能为空')
  if (!form.appSecret) errors.push('App Secret 不能为空')
  if (!form.shopId) errors.push('店铺 ID 不能为空')
  return errors
}

export function buildDouyinAccountCreateRequest(input = {}) {
  const form = normalizeDouyinAccountForm(input)
  return {
    channel: 'douyin',
    account_name: form.accountName,
    adapter_type: 'douyin_commerce',
    max_daily_quota: form.maxDailyQuota,
    config: {
      appKey: form.appKey,
      appSecret: form.appSecret,
      shopId: form.shopId
    }
  }
}

export function buildDouyinCallbackUrl(account = {}, origin = '') {
  const callbackPath = account.callbackPath ||
    `/api/channel/douyin/webhook?account_id=${encodeURIComponent(account.id ?? '')}`
  if (/^https?:\/\//i.test(callbackPath)) return callbackPath
  const normalizedOrigin = String(origin || '').replace(/\/$/, '')
  return normalizedOrigin ? `${normalizedOrigin}${callbackPath}` : callbackPath
}
