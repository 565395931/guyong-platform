const cleanText = value => typeof value === 'string' ? value.trim() : ''

export function normalizeTaobaoAccountForm(input = {}) {
  const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
  return {
    accountName: cleanText(input.accountName ?? input.account_name),
    appKey: cleanText(input.appKey),
    appSecret: cleanText(input.appSecret),
    sessionKey: cleanText(input.sessionKey),
    sellerNick: cleanText(input.sellerNick),
    maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
  }
}

export function validateTaobaoAccountForm(input = {}) {
  const form = normalizeTaobaoAccountForm(input)
  const errors = []
  if (!form.accountName) errors.push('账号名称不能为空')
  if (!form.appKey) errors.push('App Key 不能为空')
  if (!form.appSecret) errors.push('App Secret 不能为空')
  if (!form.sessionKey) errors.push('Session Key 不能为空')
  if (!form.sellerNick) errors.push('卖家昵称不能为空')
  return errors
}

export function buildTaobaoAccountCreateRequest(input = {}) {
  const form = normalizeTaobaoAccountForm(input)
  return {
    channel: 'taobao',
    account_name: form.accountName,
    adapter_type: 'taobao_commerce',
    max_daily_quota: form.maxDailyQuota,
    config: {
      appKey: form.appKey,
      appSecret: form.appSecret,
      sessionKey: form.sessionKey,
      sellerNick: form.sellerNick
    }
  }
}
