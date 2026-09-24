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
