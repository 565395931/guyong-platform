import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAccountOverview } from './accountOverview.js'

test('builds a richer account overview for the edit dialog', () => {
  const overview = buildAccountOverview(
    {
      id: 7,
      username: 'admin',
      email: 'admin@test.local',
      role: 'admin',
      status: 'active',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z'
    },
    {
      roleLabel: role => (role === 'admin' ? '管理员' : role),
      statusLabel: status => (status === 'active' ? '启用' : status),
      formatDate: value => `fmt:${value}`,
      isSelf: account => Number(account.id) === 7
    }
  )

  assert.deepEqual(overview.map(item => item.label), [
    '账号编号',
    '用户名',
    '邮箱',
    '角色',
    '状态',
    '创建时间',
    '更新时间',
    '当前账号'
  ])
  assert.equal(overview[0].value, '7')
  assert.equal(overview[3].value, '管理员')
  assert.equal(overview[7].value, '是')
})
