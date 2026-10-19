const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuickReplyPersonalizationService } = require('./quickReplyPersonalization.service')

function fixture() {
  const common = [{ id: 'shared', title: '公共', shortcut: '/hello', content: '欢迎', createdBy: null, isEnabled: true },
    { id: 'foreign', title: '其他人的私有', shortcut: '/private', content: '私有', createdBy: 9 }]
  const personal = []
  const overrides = []
  const repository = {
    base: async () => common,
    personal: async id => personal.filter(row => row.user_id === id),
    overrides: async id => overrides.filter(row => row.user_id === id),
    isPersonal: async (id, userId) => personal.some(row => row.id === id && row.user_id === userId),
    createPersonal: async (id, payload, userId) => personal.push({ id, payload, user_id: userId }),
    updatePersonal: async (id, payload, userId) => Object.assign(personal.find(row => row.id === id && row.user_id === userId), { payload }),
    removePersonal: async (id, userId) => personal.splice(personal.findIndex(row => row.id === id && row.user_id === userId), 1),
    saveOverride: async (id, payload, hidden, userId) => {
      const old = overrides.find(row => row.reply_id === id && row.user_id === userId)
      const row = { reply_id: id, payload, hidden, user_id: userId }
      if (old) Object.assign(old, row); else overrides.push(row)
    },
    resetOverrides: async userId => { for (let i = overrides.length - 1; i >= 0; i--) if (overrides[i].user_id === userId) overrides.splice(i, 1) }
  }
  return createQuickReplyPersonalizationService(repository)
}

test('editing and hiding a common reply do not change another agent view', async () => {
  const service = fixture()
  const a = { id: 1, role: 'agent' }, b = { id: 2, role: 'agent' }
  await service.update(a, 'shared', { title: '我的', shortcut: '/hello', content: '我的欢迎', isEnabled: true })
  assert.equal((await service.list(a)).list[0].content, '我的欢迎')
  assert.equal((await service.list(b)).list[0].content, '欢迎')
  await service.remove(a, 'shared')
  assert.equal((await service.list(a)).total, 0)
  assert.equal((await service.list(b)).total, 1)
  await service.reset(a)
  assert.equal((await service.list(a)).list[0].content, '欢迎')
})

test('personal additions are private and foreign identifiers cannot be read or modified', async () => {
  const service = fixture()
  const a = { id: 1, role: 'agent' }, b = { id: 2, role: 'agent' }
  const created = await service.create(a, { title: '自建', shortcut: '/own', content: '个人', isEnabled: true })
  assert.equal((await service.list(a)).total, 2)
  assert.equal((await service.list(b)).total, 1)
  await assert.rejects(service.remove(b, created.id), /话术不存在/)
  await assert.rejects(service.update(a, 'foreign', { content: '不允许' }), /话术不存在/)
  await assert.rejects(service.use(b, created.id), /话术不存在/)
  await assert.rejects(service.create(a, { shortcut: '/all' }, true), /仅管理员/)
  await assert.rejects(service.update(a, 'shared', { shortcut: '/all' }, true), /仅管理员/)
})

test('restoring common replies preserves personal additions and supports paged search', async () => {
  const service = fixture(), a = { id: 1, role: 'agent' }
  await service.create(a, { title: '自建', shortcut: '/own', content: '个人', isEnabled: true })
  await service.remove(a, 'shared')
  await service.reset(a)
  assert.equal((await service.list(a, { pageSize: 1 })).list.length, 1)
  assert.equal((await service.list(a, { keyword: '个人' })).total, 1)
})
