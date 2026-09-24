const test = require('node:test')
const assert = require('node:assert/strict')

const { createCampaignRepository } = require('./campaign.repository')

test('campaign repository resolves manual targets and tag targets without duplicates', async () => {
  const queries = []
  const sequelize = {
    query: async (sql, options = {}) => {
      queries.push({ sql, replacements: options.replacements })
      if (/FROM customer_tags/i.test(sql)) {
        return [[
          { channel: 'whatsapp', user_id: 'u1', name: 'Ada', customer_id: 'c1' },
          { channel: 'whatsapp', user_id: 'u1', name: 'Ada', customer_id: 'c1' },
          { channel: 'wechat', user_id: 'u2', name: 'Bob', customer_id: 'c2' }
        ]]
      }
      if (/FROM channel_accounts/i.test(sql)) {
        return [[
          { id: 7, channel: 'whatsapp', status: 'active', daily_quota: 0, max_daily_quota: 3, adapter_type: 'waha' }
        ]]
      }
      return [[]]
    },
    transaction: async fn => fn({})
  }

  const repository = createCampaignRepository(sequelize)
  const targets = await repository.resolveTargets({
    targetChannels: ['whatsapp', 'wechat'],
    targetUserIds: ['u1'],
    targetTags: ['vip']
  })

  assert.deepEqual(targets.map(item => `${item.channel}:${item.userId}`), [
    'whatsapp:u1',
    'wechat:u1',
    'wechat:u2'
  ])
  assert.equal(queries[0].replacements.tags.length, 1)
})

test('campaign repository writes tasks and deliveries in a transaction', async () => {
  const statements = []
  const sequelize = {
    query: async (sql, options = {}) => {
      statements.push({ sql, replacements: options.replacements })
      if (/SELECT .* FROM campaign_tasks/i.test(sql)) return [[{ id: 'task-1' }]]
      if (/SELECT .* FROM campaign_deliveries/i.test(sql)) return [[
        { id: 'delivery-1', task_id: 'task-1', status: 'scheduled', message_json: JSON.stringify({ messageType: 'text', content: { text: 'hello' } }) }
      ]]
      if (/COUNT\(\*\) AS total/i.test(sql)) return [[{ total: 1 }]]
      if (/UPDATE campaign_tasks/i.test(sql)) return [[{ affectedRows: 1 }]]
      return [[{ affectedRows: 1 }], { affectedRows: 1 }]
    },
    transaction: async fn => fn({})
  }

  const repository = createCampaignRepository(sequelize)
  const result = await repository.createTaskWithDeliveries({
    task: {
      id: 'task-1',
      name: 'Campaign',
      type: 'dm',
      targetTags: ['vip'],
      targetChannels: ['whatsapp'],
      targetUserIds: ['u1'],
      accountIds: [7],
      scripts: [{ content: 'hello', mediaFileIds: [] }],
      dailyLimit: 100,
      intervalSeconds: 30,
      sendTimeStart: null,
      sendTimeEnd: null,
      status: 'running',
      totalCount: 1,
      pendingCount: 1,
      successCount: 0,
      failedCount: 0,
      createdBy: 9
    },
    deliveries: [{
      id: 'delivery-1',
      taskId: 'task-1',
      accountId: 7,
      channel: 'whatsapp',
      userId: 'u1',
      scheduledAt: '2026-08-05T10:00:00.000Z',
      message: { messageType: 'text', content: { text: 'hello' } },
      mediaFileIds: [],
      status: 'scheduled'
    }]
  })

  assert.equal(result.id, 'task-1')
  assert.equal(statements.length > 0, true)
})
