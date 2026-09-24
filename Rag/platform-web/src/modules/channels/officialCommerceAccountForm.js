const cleanText = value => typeof value === 'string' ? value.trim() : ''

export function createOfficialCommerceAccountForm({ channel, adapterType, fields }) {
  function normalize(input = {}) {
    const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
    return {
      accountName: cleanText(input.accountName ?? input.account_name),
      ...Object.fromEntries(fields.map(({ name }) => [name, cleanText(input[name])])),
      maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
    }
  }

  function validate(input = {}) {
    const form = normalize(input)
    const errors = []
    if (!form.accountName) errors.push('账号名称不能为空')
    for (const field of fields) {
      if (!form[field.name]) errors.push(`${field.label} 不能为空`)
    }
    return errors
  }

  function buildRequest(input = {}) {
    const form = normalize(input)
    return {
      channel,
      account_name: form.accountName,
      adapter_type: adapterType,
      max_daily_quota: form.maxDailyQuota,
      config: Object.fromEntries(fields.map(({ name }) => [name, form[name]]))
    }
  }

  return { normalize, validate, buildRequest }
}
