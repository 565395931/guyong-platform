import test from 'node:test'
import assert from 'node:assert/strict'

async function loadFilters() {
  const module = await import('./platformFilters.js').catch(() => null)
  assert.ok(module, 'platformFilters.js should exist')
  return module
}

test('normalizes supported platform aliases and rejects unknown values', async () => {
  const { normalizePlatformChannel } = await loadFilters()

  assert.equal(normalizePlatformChannel('1688'), 'alibaba1688')
  assert.equal(normalizePlatformChannel('qianniu'), 'taobao')
  assert.equal(normalizePlatformChannel(['WhatsApp']), 'whatsapp')
  assert.equal(normalizePlatformChannel('wechat'), 'wechat')
  assert.equal(normalizePlatformChannel('unknown'), '')
  assert.equal(normalizePlatformChannel(''), '')
})

test('normalizes views and keeps business events on supported commerce platforms', async () => {
  const { normalizeMessageFilters } = await loadFilters()

  assert.deepEqual(normalizeMessageFilters({ channel: 'taobao', view: 'events' }), {
    channel: 'taobao', view: 'events'
  })
  assert.deepEqual(normalizeMessageFilters({ channel: '', view: 'events' }), {
    channel: 'douyin', view: 'events'
  })
  assert.deepEqual(normalizeMessageFilters({ channel: 'whatsapp', view: 'events' }), {
    channel: 'whatsapp', view: 'conversations'
  })
  assert.deepEqual(normalizeMessageFilters({ channel: 'wechat', view: 'events' }), {
    channel: 'wechat', view: 'conversations'
  })
  assert.deepEqual(normalizeMessageFilters({ channel: 'wecom_kf', view: 'invalid' }), {
    channel: 'wecom_kf', view: 'conversations'
  })
})

test('normalizes account options without collapsing multiple WhatsApp accounts', async () => {
  const { normalizeChannelAccountOptions } = await loadFilters()
  const result = normalizeChannelAccountOptions([
    { id: 11, channel: 'whatsapp', account_name: 'WA Sales A', status: 'active' },
    { id: 12, channel: 'whatsapp', account_name: 'WA Sales B', status: 'active' }
  ])

  assert.deepEqual(result, [
    { id: 11, channel: 'whatsapp', name: 'WA Sales A', status: 'active' },
    { id: 12, channel: 'whatsapp', name: 'WA Sales B', status: 'active' }
  ])
})

test('identifies channels that require a desktop bridge for chat', async () => {
  const { requiresDesktopBridge, DESKTOP_BRIDGE_CHANNELS } = await loadFilters()

  assert.deepEqual(DESKTOP_BRIDGE_CHANNELS, [
    'douyin', 'pinduoduo', 'taobao', 'alibaba1688',
    'xiaohongshu', 'wechat_shop', 'kuaishou'
  ])
  assert.equal(requiresDesktopBridge('taobao'), true)
  assert.equal(requiresDesktopBridge('xiaohongshu'), true)
  assert.equal(requiresDesktopBridge('wechat_shop'), true)
  assert.equal(requiresDesktopBridge('kuaishou'), true)
  assert.equal(requiresDesktopBridge('wechat'), false)
  assert.equal(requiresDesktopBridge('whatsapp'), false)
  assert.equal(requiresDesktopBridge(''), false)
})
