const cleanText = value => String(value || '').trim()
const cleanCredential = value => {
  const text = cleanText(value)
  return /^\*{4,}$/.test(text) ? '' : text
}

export function normalizeConnectionForm(input = {}) {
  return {
    connectionName: cleanText(input.connectionName),
    corpId: cleanText(input.corpId),
    secret: cleanCredential(input.secret),
    callbackToken: cleanCredential(input.callbackToken),
    encodingAesKey: cleanCredential(input.encodingAesKey)
  }
}

export function validateConnectionForm(input = {}) {
  const form = normalizeConnectionForm(input)
  const errors = []
  if (!form.connectionName) errors.push('企业连接名称不能为空')
  if (!form.corpId) errors.push('CorpID 不能为空')
  if (!form.secret) errors.push('微信客服 Secret 不能为空')
  if (!form.callbackToken) errors.push('回调 Token 不能为空')
  if (!form.encodingAesKey) errors.push('EncodingAESKey 不能为空')
  return errors
}

export function normalizeCredentialReplacementForm(input = {}) {
  return {
    secret: cleanCredential(input.secret),
    callbackToken: cleanCredential(input.callbackToken),
    encodingAesKey: cleanCredential(input.encodingAesKey)
  }
}

export function validateCredentialReplacementForm(input = {}) {
  const form = normalizeCredentialReplacementForm(input)
  const errors = []
  if (!form.secret) errors.push('微信客服 Secret 不能为空')
  if (!form.callbackToken) errors.push('回调 Token 不能为空')
  if (!form.encodingAesKey) errors.push('EncodingAESKey 不能为空')
  return errors
}

export function normalizePolicyForm(input = {}) {
  return {
    protectionLevel: cleanText(input.protectionLevel || 'locked').toLowerCase(),
    aiEnabled: input.aiEnabled === true,
    allowlistEnabled: input.allowlistEnabled !== false
  }
}

export function validatePolicyForm(input = {}) {
  const policy = normalizePolicyForm(input)
  const errors = []
  if (!['locked', 'test'].includes(policy.protectionLevel)) errors.push('当前阶段只允许生产保护或测试模式')
  if (policy.protectionLevel === 'locked' && policy.aiEnabled) errors.push('生产保护账号不能启用 AI')
  if (policy.protectionLevel === 'test' && policy.aiEnabled && !policy.allowlistEnabled) {
    errors.push('测试账号启用 AI 前必须开启白名单')
  }
  return errors
}

export function canPublishRuntime(connection = {}) {
  return ['verified', 'active'].includes(connection.status) && Number(connection.accountCount || 0) > 0
}

export function canDisableRuntime(connection = {}) {
  return connection.status === 'active'
}

export function canEditAccountConfiguration(connection = {}) {
  return Boolean(connection.status) && connection.status !== 'active'
}

export function canOpenAllowlist(account = {}) {
  return account.protectionLevel === 'test' && account.lockedReason !== 'production_baseline'
}

export function normalizeAllowlistForm(input = {}) {
  return {
    externalUserId: cleanText(input.externalUserId),
    label: cleanText(input.label)
  }
}

export function validateAllowlistForm(input = {}) {
  const form = normalizeAllowlistForm(input)
  const errors = []
  if (!form.externalUserId) errors.push('外部联系人 ID 不能为空')
  else if (form.externalUserId.length > 160) errors.push('外部联系人 ID 不能超过 160 个字符')
  if (form.label.length > 120) errors.push('备注不能超过 120 个字符')
  return errors
}

export function normalizeOperationLogFilters(input = {}) {
  const normalized = {
    connectionId: Number(input.connectionId) || null,
    accountId: Number(input.accountId) || null,
    action: cleanText(input.action) || null,
    page: Math.max(1, Number(input.page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(input.pageSize) || 20))
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value != null && value !== ''))
}
