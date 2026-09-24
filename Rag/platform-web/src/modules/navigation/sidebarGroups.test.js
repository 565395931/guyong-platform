import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../components/Layout/AppSidebar.vue', import.meta.url), 'utf8')

test('sidebar renders review badge data instead of relying on a header command', () => {
  assert.match(source, /child\.badge\s*===\s*'review'/)
  assert.match(source, /el-badge/)
})

test('sidebar registers group icons for customer work and business operations', () => {
  assert.match(source, /Headset/)
  assert.match(source, /Briefcase/)
  assert.match(source, /TrendCharts/)
})

test('sidebar supports collapsible sections and nested platform navigation', () => {
  assert.match(source, /toggleExpanded/)
  assert.match(source, /app-sidebar__section-toggle/)
  assert.match(source, /app-sidebar__nested-toggle/)
  assert.match(source, /route\.fullPath/)
})

test('platform tabs are no longer duplicated above content views', () => {
  const messages = readFileSync(new URL('../../views/PlatformMessages/PlatformMessagesView.vue', import.meta.url), 'utf8')
  const accounts = readFileSync(new URL('../../views/Settings/CustomerServiceAccountsView.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(messages, /message-toolbar__platforms/)
  assert.doesNotMatch(accounts, /v-for="option in PLATFORM_OPTIONS"/)
})
