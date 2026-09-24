const cleanText = value => typeof value === 'string' ? value.trim() : ''

export function normalizeAlibaba1688AccountForm(input = {}) {
  const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
  return {
    accountName: cleanText(input.accountName ?? input.account_name),
    appKey: cleanText(input.appKey),
    appSecret: cleanText(input.appSecret),
    accessToken: cleanText(input.accessToken),
    sellerMemberId: cleanText(input.sellerMemberId),
    maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
  }
}

export function validateAlibaba1688AccountForm(input = {}) {
  const form = normalizeAlibaba1688AccountForm(input)
  const errors = []
  if (!form.accountName) errors.push('账号名称不能为空')
  if (!form.appKey) errors.push('App Key 不能为空')
  if (!form.appSecret) errors.push('App Secret 不能为空')
  if (!form.accessToken) errors.push('Access Token 不能为空')
  if (!form.sellerMemberId) errors.push('Seller Member ID 不能为空')
  return errors
}

export function buildAlibaba1688AccountCreateRequest(input = {}) {
  const form = normalizeAlibaba1688AccountForm(input)
  return {
    channel: 'alibaba1688',
    account_name: form.accountName,
    adapter_type: 'alibaba1688_commerce',
    max_daily_quota: form.maxDailyQuota,
    config: {
      appKey: form.appKey,
      appSecret: form.appSecret,
      accessToken: form.accessToken,
      sellerMemberId: form.sellerMemberId
    }
  }
}
