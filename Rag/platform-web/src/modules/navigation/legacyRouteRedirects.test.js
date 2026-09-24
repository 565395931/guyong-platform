import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

async function loadRedirects() {
  const module = await import('./legacyRouteRedirects.js').catch(() => null)
  assert.ok(module, 'legacyRouteRedirects.js should exist')
  return module
}

test('conversation routes redirect to unified messages with platform context', async () => {
  const { resolveLegacyRoute } = await loadRedirects()

  assert.deepEqual(resolveLegacyRoute('/workbench'), {
    path: '/platform-messages',
    query: { view: 'conversations' }
  })
  assert.deepEqual(resolveLegacyRoute('/wecom/conversations'), {
    path: '/platform-messages',
    query: { channel: 'wecom_kf', view: 'conversations' }
  })
  assert.deepEqual(resolveLegacyRoute('/whatsapp/conversations'), {
    path: '/platform-messages',
    query: { channel: 'whatsapp', view: 'conversations' }
  })
})

test('event routes redirect to unified messages for every commerce platform', async () => {
  const { resolveLegacyRoute } = await loadRedirects()
  const expected = {
    '/douyin/events': 'douyin',
    '/pinduoduo/events': 'pinduoduo',
    '/taobao/events': 'taobao',
    '/1688/events': 'alibaba1688'
  }

  for (const [path, channel] of Object.entries(expected)) {
    assert.deepEqual(resolveLegacyRoute(path), {
      path: '/platform-messages',
      query: { channel, view: 'events' }
    })
  }
})

test('account routes redirect to unified account management', async () => {
  const { resolveLegacyRoute } = await loadRedirects()
  const expected = {
    '/wecom/accounts': 'wecom_kf',
    '/platform-accounts': 'wecom_kf',
    '/douyin/accounts': 'douyin',
    '/pinduoduo/accounts': 'pinduoduo',
    '/taobao/accounts': 'taobao',
    '/1688/accounts': 'alibaba1688'
  }

  for (const [path, channel] of Object.entries(expected)) {
    assert.deepEqual(resolveLegacyRoute(path), {
      path: '/customer-service-accounts',
      query: { channel }
    })
  }
  assert.equal(resolveLegacyRoute('/unknown'), null)
})

test('router redirect preserves unrelated query values and canonical context wins', async () => {
  const { redirectLegacyRoute } = await loadRedirects()

  assert.deepEqual(redirectLegacyRoute({
    path: '/taobao/events',
    query: { account: '42', channel: 'wrong' }
  }), {
    path: '/platform-messages',
    query: { account: '42', channel: 'taobao', view: 'events' }
  })
})

test('router exposes canonical routes and no longer falls back to workbench', () => {
  const source = readFileSync(new URL('../../router/index.js', import.meta.url), 'utf8')

  assert.match(source, /path:\s*'platform-messages'[\s\S]*PlatformMessagesView\.vue/)
  assert.match(source, /path:\s*'customer-service-accounts'[\s\S]*CustomerServiceAccountsView\.vue/)
  assert.match(source, /path:\s*'settings\/video-data'[\s\S]*VideoDataManageView\.vue/)
  assert.doesNotMatch(source, /next\('\/workbench'\)/)
})
