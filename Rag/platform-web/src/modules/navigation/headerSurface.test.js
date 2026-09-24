import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../components/Layout/AppHeader.vue', import.meta.url), 'utf8')

test('header keeps status, reminders and user controls without navigation commands', () => {
  assert.match(source, /ChannelStatusIndicator/)
  assert.match(source, /app-header__reminder-btn/)
  assert.match(source, /app-header__user-info/)
  assert.doesNotMatch(source, /app-header__tools/)
  assert.doesNotMatch(source, /buildHeaderNavigation/)
  assert.doesNotMatch(source, /message-reviews/)
})
