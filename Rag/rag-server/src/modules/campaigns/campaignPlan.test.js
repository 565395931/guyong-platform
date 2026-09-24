const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeCampaignInput,
  renderScript,
  buildDispatchPlan
} = require('./campaignPlan')

test('normalizes a valid campaign and applies conservative defaults', () => {
  const result = normalizeCampaignInput({
    name: '夏季新品触达',
    type: 'dm',
    targetChannels: ['whatsapp'],
    targetUserIds: ['8613800138000@c.us'],
    scripts: [{ content: '你好{name}，想了解{product}吗？' }]
  })

  assert.equal(result.error, undefined)
  assert.equal(result.data.dailyLimit, 100)
  assert.equal(result.data.intervalSeconds, 30)
  assert.deepEqual(result.data.targetChannels, ['whatsapp'])
})

test('rejects unsafe or incomplete campaign input', () => {
  assert.equal(normalizeCampaignInput({}).error, '任务名称不能为空')
  assert.match(
    normalizeCampaignInput({
      name: 'x',
      type: 'dm',
      targetChannels: ['whatsapp'],
      targetUserIds: ['1'],
      scripts: [{ content: 'x' }],
      dailyLimit: 0
    }).error,
    /每日上限/
  )
  assert.match(
    normalizeCampaignInput({
      name: 'x',
      type: 'dm',
      targetChannels: ['unknown'],
      targetUserIds: ['1'],
      scripts: [{ content: 'x' }]
    }).error,
    /渠道/
  )
})

test('renders variables without mutating the source script', () => {
  const source = 'Hi {name}, price is {price}. {missing}'
  assert.equal(renderScript(source, { name: 'Ada', price: 12 }), 'Hi Ada, price is 12. {missing}')
  assert.equal(source, 'Hi {name}, price is {price}. {missing}')
})

test('builds a round-robin dispatch plan within account quotas', () => {
  const plan = buildDispatchPlan({
    targets: [
      { userId: 'u1', channel: 'whatsapp', name: 'A' },
      { userId: 'u2', channel: 'whatsapp', name: 'B' },
      { userId: 'u3', channel: 'whatsapp', name: 'C' }
    ],
    accounts: [
      { id: 1, channel: 'whatsapp', status: 'active', dailyQuota: 0, maxDailyQuota: 1 },
      { id: 2, channel: 'whatsapp', status: 'active', dailyQuota: 0, maxDailyQuota: 1 }
    ],
    config: {
      intervalSeconds: 10,
      scripts: [{ content: 'Hello {name}' }]
    },
    now: new Date('2026-08-05T08:00:00.000Z')
  })

  assert.equal(plan.length, 2)
  assert.deepEqual(plan.map(item => item.accountId), [1, 2])
  assert.equal(plan[1].message.content.text, 'Hello B')
  assert.equal(plan[1].scheduledAt, '2026-08-05T08:00:10.000Z')
})
