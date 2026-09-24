import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeAccountForm, validateAccountForm, canMutateAccount } from './accountRules.js'

test('normalizes system account form values', () => {
  assert.deepEqual(normalizeAccountForm({
    username: ' admin2 ', email: ' ADMIN2@EXAMPLE.COM ', password: '123456', role: 'admin', status: 'active'
  }), {
    username: 'admin2', email: 'admin2@example.com', password: '123456', role: 'admin', status: 'active'
  })
})

test('validates create and edit forms with readable errors', () => {
  assert.deepEqual(validateAccountForm({ username: 'a', password: '123', email: 'bad', role: 'owner', status: 'x' }, { creating: true }), {
    username: '用户名长度必须为 2-50 个字符',
    email: '邮箱格式不正确',
    password: '密码至少 6 个字符',
    role: '请选择有效角色',
    status: '请选择有效状态'
  })
  assert.deepEqual(validateAccountForm({ username: 'agent1', email: '', role: 'agent', status: 'active' }, { creating: false }), {})
})

test('current account cannot be disabled or deleted', () => {
  assert.equal(canMutateAccount({ id: 1 }, 1, 'disable'), false)
  assert.equal(canMutateAccount({ id: 1 }, 1, 'delete'), false)
  assert.equal(canMutateAccount({ id: 2 }, 1, 'delete'), true)
})
