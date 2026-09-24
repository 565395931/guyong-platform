export function buildAccountOverview(
  account = {},
  {
    roleLabel = value => value || '-',
    statusLabel = value => value || '-',
    formatDate = value => value || '-',
    isSelf = () => false
  } = {}
) {
  return [
    { label: '账号编号', value: account.id != null ? String(account.id) : '-' },
    { label: '用户名', value: account.username || '-' },
    { label: '邮箱', value: account.email || '未设置' },
    { label: '角色', value: roleLabel(account.role) },
    { label: '状态', value: statusLabel(account.status) },
    { label: '创建时间', value: formatDate(account.createdAt) },
    { label: '更新时间', value: formatDate(account.updatedAt) },
    { label: '当前账号', value: isSelf(account) ? '是' : '否' }
  ]
}
