const test = require('node:test')
const assert = require('node:assert/strict')

const { createSystemAccountsService } = require('./systemAccounts.service')

function harness(overrides = {}) {
  const calls = []
  const users = new Map([
    [1, { id: 1, username: 'admin', email: 'admin@test.local', role: 'admin', status: 'active', password: 'secret-hash' }],
    [2, { id: 2, username: 'agent1', email: null, role: 'agent', status: 'active', password: 'agent-hash' }]
  ])
  const repository = {
    list: async () => [...users.values()],
    findById: async id => users.get(Number(id)) || null,
    findByUsername: async username => [...users.values()].find(user => user.username === username) || null,
    findByEmail: async email => [...users.values()].find(user => user.email === email) || null,
    countActiveAdmins: async () => [...users.values()].filter(user => user.role === 'admin' && user.status === 'active').length,
    create: async input => {
      calls.push(['create', input])
      const user = { id: 3, ...input }
      users.set(3, user)
      return user
    },
    update: async (id, input) => {
      calls.push(['update', Number(id), input])
      const user = { ...users.get(Number(id)), ...input }
      users.set(Number(id), user)
      return user
    },
    remove: async id => { calls.push(['remove', Number(id)]); users.delete(Number(id)) },
    ...overrides
  }
  const service = createSystemAccountsService({ repository, hashPassword: async password => `hash:${password}` })
  return { service, calls, users }
}

test('creates a validated account and never exposes the password hash', async () => {
  const { service, calls } = harness()
  const result = await service.create({
    username: ' supervisor1 ', password: '123456', email: 'boss@example.com', role: 'supervisor'
  })
  assert.equal(result.username, 'supervisor1')
  assert.equal(result.password, undefined)
  assert.equal(calls[0][1].password, 'hash:123456')
  assert.equal(calls[0][1].status, 'active')
})

test('rejects invalid account input and duplicate identifiers', async () => {
  const { service } = harness()
  await assert.rejects(() => service.create({ username: 'a', password: '123456', role: 'agent' }), /用户名长度/)
  await assert.rejects(() => service.create({ username: 'new-user', password: '123', role: 'agent' }), /密码至少/)
  await assert.rejects(() => service.create({ username: 'new-user', password: '123456', email: 'bad', role: 'agent' }), /邮箱格式/)
  await assert.rejects(() => service.create({ username: 'admin', password: '123456', role: 'agent' }), /用户名已存在/)
})

test('protects the current account from disabling, demotion and deletion', async () => {
  const { service } = harness()
  await assert.rejects(() => service.update(1, { status: 'disabled' }, { actorId: 1 }), /不能禁用当前登录账号/)
  await assert.rejects(() => service.update(1, { role: 'agent' }, { actorId: 1 }), /不能修改当前登录账号的角色/)
  await assert.rejects(() => service.remove(1, { actorId: 1 }), /不能删除当前登录账号/)
})

test('keeps at least one active administrator', async () => {
  const { service } = harness()
  await assert.rejects(() => service.update(1, { status: 'disabled' }, { actorId: 99 }), /至少保留一个启用状态的管理员/)
  await assert.rejects(() => service.update(1, { role: 'supervisor' }, { actorId: 99 }), /至少保留一个启用状态的管理员/)
  await assert.rejects(() => service.remove(1, { actorId: 99 }), /至少保留一个启用状态的管理员/)
})

test('resets password using the injected hasher and returns safe user data', async () => {
  const { service, calls } = harness()
  const result = await service.resetPassword(2, { password: 'new-pass-123' })
  assert.equal(calls[0][2].password, 'hash:new-pass-123')
  assert.equal(result.password, undefined)
  assert.equal(result.username, 'agent1')
})
