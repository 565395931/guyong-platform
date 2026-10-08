const test = require('node:test')
const assert = require('node:assert/strict')

const channelStatusRouter = require('./channelStatus')

const { buildChannelStatusSummary } = channelStatusRouter

test('reports warning when WhatsApp is partial and WeCom is active', () => {
  const accountRows = [
    { channel: 'whatsapp', account_count: '2' },
    { channel: 'wecom_kf', account_count: '1' }
  ]
  const sessions = [
    {
      sessionName: 'wa-primary',
      status: 'WORKING',
      phone: '15550001111',
      displayName: 'Primary'
    },
    {
      sessionName: 'wa-backup',
      status: 'OFFLINE',
      phone: '',
      displayName: ''
    }
  ]

  const summary = buildChannelStatusSummary(accountRows, sessions)

  assert.equal(summary.overall, 'WARNING')
  assert.deepEqual(summary.channels[0], {
    channel: 'whatsapp',
    label: 'WhatsApp',
    accountCount: 2,
    status: 'PARTIAL',
    sessions: [
      { name: 'Primary', status: 'WORKING', phone: '15550001111' },
      { name: 'wa-backup', status: 'OFFLINE', phone: '' }
    ]
  })
  assert.equal(summary.channels[1].channel, 'wecom_kf')
  assert.equal(summary.channels[1].accountCount, 1)
  assert.equal(summary.channels[1].status, 'ACTIVE')
})

test('reports critical when every WhatsApp session is offline', () => {
  const summary = buildChannelStatusSummary(
    [{ channel: 'whatsapp', account_count: 2 }],
    [
      { sessionName: 'wa-one', status: 'OFFLINE', phone: '', displayName: '' },
      { sessionName: 'wa-two', status: 'OFFLINE', phone: '', displayName: '' }
    ]
  )

  assert.equal(summary.overall, 'CRITICAL')
  assert.equal(summary.channels[0].status, 'OFFLINE')
})

test('reports unknown when no channel accounts are configured', () => {
  assert.deepEqual(buildChannelStatusSummary([], []), {
    overall: 'UNKNOWN',
    channels: []
  })
})

// ========== 桌面桥接（抖店本地客户端）健康判定 ==========
// 抖店没有"会话"可以查，唯一信号是有没有节点持有有效租约；掉线就要能让界面闪红光。

test('reports douyin as CONNECTED when a node holds a live lease', () => {
  const summary = buildChannelStatusSummary(
    [{ channel: 'douyin', account_count: '1' }],
    null,
    { douyin: true }
  )

  assert.equal(summary.overall, 'HEALTHY')
  assert.equal(summary.channels[0].status, 'CONNECTED')
})

test('reports douyin as OFFLINE and overall CRITICAL when no node holds a lease', () => {
  const summary = buildChannelStatusSummary(
    [{ channel: 'douyin', account_count: '1' }],
    null,
    { douyin: false }
  )

  assert.equal(summary.overall, 'CRITICAL')
  assert.equal(summary.channels[0].status, 'OFFLINE')
})

test('keeps the old behaviour for channels without desktop bridge info', () => {
  const summary = buildChannelStatusSummary(
    [{ channel: 'douyin', account_count: '1' }, { channel: 'wecom_kf', account_count: '1' }],
    null
  )

  // 不传第三个参数 = 不判（老调用方/测试只关心 WhatsApp）
  assert.equal(summary.channels[0].status, 'ACTIVE')
  assert.equal(summary.channels[1].status, 'ACTIVE')
})
