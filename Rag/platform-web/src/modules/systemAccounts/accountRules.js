export const ACCOUNT_ROLES = Object.freeze(['admin', 'supervisor', 'agent'])
export const ACCOUNT_STATUSES = Object.freeze(['active', 'disabled'])

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeAccountForm(input = {}) {
  return {
    username: String(input.username || '').trim(),
    email: String(input.email || '').trim().toLowerCase(),
    password: String(input.password || ''),
    role: input.role || 'agent',
    status: input.status || 'active'
  }
}

export function validateAccountForm(input = {}, { creating = true } = {}) {
  const form = normalizeAccountForm(input)
  const errors = {}
  if (form.username.length < 2 || form.username.length > 50) {
    errors.username = '用户名长度必须为 2-50 个字符'
  } else if (!/^[\w.-]+$/.test(form.username)) {
    errors.username = '用户名只能包含字母、数字、下划线、点和短横线'
  }
  if (form.email && !EMAIL_PATTERN.test(form.email)) errors.email = '邮箱格式不正确'
  if ((creating || form.password) && form.password.length < 6) errors.password = '密码至少 6 个字符'
  if (form.password.length > 72) errors.password = '密码不能超过 72 个字符'
  if (!ACCOUNT_ROLES.includes(form.role)) errors.role = '请选择有效角色'
  if (!ACCOUNT_STATUSES.includes(form.status)) errors.status = '请选择有效状态'
  return errors
}

export function canMutateAccount(account, actorId, action) {
  const isSelf = Number(account?.id) === Number(actorId)
  return !(isSelf && ['disable', 'delete', 'role'].includes(action))
}
