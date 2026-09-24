const test = require('node:test')
const assert = require('node:assert/strict')

const { createCampaignService } = require('./campaignService')
const { createCampaignDispatcher } = require('./campaignDispatcher')

test('campaign service persists a runnable task and its dispatch plan', async () => {
  const saved = []
  const repository = {
    resolveTargets: async () => [
      { userId: '8613800138000@c.us', channel: 'whatsapp', name: 'Ada' }
    ],
    listActiveAccounts: async () => [
      { id: 7, channel: 'whatsapp', status: 'active', dailyQuota: 0, maxDailyQuota: 10 }
    ],
    createTaskWithDeliveries: async payload => {
      saved.push(payload)
      return { id: 'task-1', status: 'running', totalCount: payload.deliveries.length }
    }
  }

  const service = createCampaignService({ repository, idFactory: () => 'task-1' })
  const result = await service.create({
    name: '新品触达',
    type: 'dm',
    targetChannels: ['whatsapp'],
    targetUserIds: ['8613800138000@c.us'],
    scripts: [{ content: 'Hello {name}' }]
  }, { id: 9, role: 'supervisor' })

  assert.equal(result.id, 'task-1')
  assert.equal(saved[0].deliveries[0].message.content.text, 'Hello Ada')
  assert.equal(saved[0].task.createdBy, 9)
})

test('campaign service refuses to create a task when no account can deliver it', async () => {
  const service = createCampaignService({
    repository: {
      resolveTargets: async () => [{ userId: 'u1', channel: 'whatsapp' }],
      listActiveAccounts: async () => []
    }
  })

  await assert.rejects(
    () => service.create({
      name: 'x',
      type: 'dm',
      targetChannels: ['whatsapp'],
      targetUserIds: ['u1'],
      scripts: [{ content: 'Hello' }]
    }, { id: 1 }),
    error => error.statusCode === 409 && /可用账号/.test(error.message)
  )
})

test('dispatcher sends one claimed delivery and records the channel message id', async () => {
  const calls = []
  const repository = {
    claimNextDelivery: async () => ({
      id: 'delivery-1',
      taskId: 'task-1',
      accountId: 7,
      adapterType: 'waha',
      userId: 'u1',
      message: { messageType: 'text', content: { text: 'Hello' } }
    }),
    reserveAccountQuota: async () => true,
    completeDelivery: async (id, result) => calls.push(['complete', id, result]),
    failDelivery: async () => assert.fail('delivery must not fail'),
    refreshTaskCounts: async taskId => calls.push(['refresh', taskId])
  }
  const dispatcher = createCampaignDispatcher({
    repository,
    adapterResolver: () => ({
      sendMessage: async () => ({ success: true, channelMsgId: 'wa-1' })
    })
  })

  const result = await dispatcher.runOnce()

  assert.equal(result.status, 'success')
  assert.deepEqual(calls[0], ['complete', 'delivery-1', { channelMessageId: 'wa-1' }])
  assert.deepEqual(calls[1], ['refresh', 'task-1'])
})

test('dispatcher records adapter failures and refreshes task counters', async () => {
  const calls = []
  const repository = {
    claimNextDelivery: async () => ({
      id: 'delivery-2', taskId: 'task-2', accountId: 8, adapterType: 'waha', userId: 'u2',
      message: { messageType: 'text', content: { text: 'Hello' } }
    }),
    reserveAccountQuota: async () => true,
    completeDelivery: async () => assert.fail('delivery must not complete'),
    failDelivery: async (id, error) => calls.push(['fail', id, error]),
    refreshTaskCounts: async taskId => calls.push(['refresh', taskId])
  }
  const dispatcher = createCampaignDispatcher({
    repository,
    adapterResolver: () => ({ sendMessage: async () => ({ success: false, error: 'gateway offline' }) })
  })

  const result = await dispatcher.runOnce()

  assert.equal(result.status, 'failed')
  assert.deepEqual(calls, [
    ['fail', 'delivery-2', 'gateway offline'],
    ['refresh', 'task-2']
  ])
})

