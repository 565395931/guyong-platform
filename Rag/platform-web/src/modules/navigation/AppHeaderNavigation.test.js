import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../components/Layout/AppHeader.vue', import.meta.url), 'utf8')

test('header leaves navigation and review count in the persistent sidebar', () => {
  assert.doesNotMatch(source, /buildHeaderNavigation/)
  assert.doesNotMatch(source, /headerNavigation\./)
  assert.doesNotMatch(source, /app-header__tools/)
  assert.doesNotMatch(source, /getReviewStats/)
  assert.doesNotMatch(source, /消息审核/)
})

test('websocket client forwards message review updates to local listeners', () => {
  const websocketSource = readFileSync(new URL('../../api/websocket.js', import.meta.url), 'utf8')
  assert.match(websocketSource, /socket\.on\('message_review_updated'/)
  assert.match(websocketSource, /_dispatch\('message_review_updated'/)
})

test('header routes navigation commands without replacing reminder and user controls', () => {
  assert.match(source, /router\.push/)
  assert.match(source, /ChannelStatusIndicator/)
  assert.match(source, /reminderSettings/)
  assert.match(source, /handleCommand/)
})
