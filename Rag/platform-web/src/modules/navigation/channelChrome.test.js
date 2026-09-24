import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { resolveChannelChrome } from './channelChrome.js'

test('WeCom pages do not show the WhatsApp connection indicator', () => {
  assert.deepEqual(resolveChannelChrome('wecom_kf'), {
    channelCode: 'wecom_kf',
    showWahaStatus: false
  })
})

test('WhatsApp and shared pages keep the WhatsApp connection indicator', () => {
  assert.equal(resolveChannelChrome('whatsapp').showWahaStatus, true)
  assert.equal(resolveChannelChrome('').showWahaStatus, true)
})

test('WeCom account management uses an explicit customer-service title', () => {
  const source = readFileSync(
    new URL('../../views/Settings/PlatformAccountsView.vue', import.meta.url),
    'utf8'
  )

  assert.match(source, /<h1>微信客服账号<\/h1>/)
})
