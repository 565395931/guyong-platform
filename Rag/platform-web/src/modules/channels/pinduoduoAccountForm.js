const cleanText = value => typeof value === 'string' ? value.trim() : ''

export function normalizePinduoduoAccountForm(input = {}) {
  const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
  return {
    accountName: cleanText(input.accountName ?? input.account_name),
    clientId: cleanText(input.clientId),
    clientSecret: cleanText(input.clientSecret),
    accessToken: cleanText(input.accessToken),
    mallId: cleanText(input.mallId),
    maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
  }
}

export function validatePinduoduoAccountForm(input = {}) {
  const form = normalizePinduoduoAccountForm(input)
  const errors = []
  if (!form.accountName) errors.push('账号名称不能为空')
  if (!form.clientId) errors.push('Client ID 不能为空')
  if (!form.clientSecret) errors.push('Client Secret 不能为空')
  if (!form.accessToken) errors.push('Access Token 不能为空')
  if (!form.mallId) errors.push('Mall ID 不能为空')
  return errors
}

export function buildPinduoduoAccountCreateRequest(input = {}) {
  const form = normalizePinduoduoAccountForm(input)
  return {
    channel: 'pinduoduo',
    account_name: form.accountName,
    adapter_type: 'pinduoduo_commerce',
    max_daily_quota: form.maxDailyQuota,
    config: {
      clientId: form.clientId,
      clientSecret: form.clientSecret,
      accessToken: form.accessToken,
      mallId: form.mallId
    }
  }
}
