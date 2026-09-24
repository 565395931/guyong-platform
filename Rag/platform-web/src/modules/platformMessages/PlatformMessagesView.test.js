import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

test('channel API exposes normalized account options through the existing endpoint', () => {
  const source = readFileSync(new URL('../../api/channels.js', import.meta.url), 'utf8')

  assert.match(source, /export async function getChannelAccountOptions\(params = \{\}\)/)
  assert.match(source, /getChannelAccounts\(params\)/)
  assert.match(source, /normalizeChannelAccountOptions/)
})

test('unified platform messages view composes conversations and business events', () => {
  const viewUrl = new URL('../../views/PlatformMessages/PlatformMessagesView.vue', import.meta.url)
  assert.equal(existsSync(viewUrl), true)
  const source = existsSync(viewUrl) ? readFileSync(viewUrl, 'utf8') : ''

  assert.match(source, /<WorkbenchView/)
  assert.match(source, /<ChannelEventsView/)
  assert.match(source, /channel:\s*route\.query\.channel/)
  assert.doesNotMatch(source, /v-model="selectedChannel"/)
  assert.match(source, /v-model="selectedAccountId"/)
  assert.match(source, /v-model="selectedView"/)
  assert.match(source, /getChannelAccountOptions/)
  assert.match(source, /router\.replace/)
  assert.match(source, /DESKTOP_BRIDGE_CHANNELS/)
  assert.match(source, /需要在线桌面节点/)
})
