import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('workbench accepts explicit channel and account scope for embedding', () => {
  const source = readSource('../../views/Workbench/WorkbenchView.vue')

  assert.match(source, /channelCode:\s*\{\s*type:\s*String,\s*default:\s*''\s*\}/)
  assert.match(source, /accountId:\s*\{\s*type:\s*\[String, Number\],\s*default:\s*''\s*\}/)
  assert.match(source, /embedded:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
  assert.match(source, /prop:\s*props\.channelCode/)
  assert.match(source, /query:\s*route\.query\.channel/)
  assert.match(source, /:account-id="props\.accountId"/)
})

test('conversation list sends account scope to the backend and reloads when it changes', () => {
  const source = readSource('../../components/Conversation/ConversationList.vue')

  assert.match(source, /accountId:\s*\{\s*type:\s*\[String, Number\],\s*default:\s*''\s*\}/)
  assert.match(source, /<el-option label="微信小程序" value="wechat" \/>/)
  assert.match(source, /params\.account_id\s*=\s*props\.accountId/)
  assert.match(source, /props\.fixedChannel,\s*props\.accountId/)
})

test('conversation list and chat detail label WeChat mini program conversations explicitly', () => {
  const list = readSource('../../components/Conversation/ConversationItem.vue')
  const chat = readSource('../../components/Chat/ChatWindow.vue')

  assert.match(list, /'wechat': '微信小程序'/)
  assert.match(chat, /'wechat': '微信小程序'/)
})

test('channel events accepts prop/query scope and removes page heading when embedded', () => {
  const source = readSource('../../views/Channels/ChannelEventsView.vue')

  assert.match(source, /channelCode:\s*\{\s*type:\s*String,\s*default:\s*''\s*\}/)
  assert.match(source, /accountId:\s*\{\s*type:\s*\[String, Number\],\s*default:\s*''\s*\}/)
  assert.match(source, /query:\s*route\.query\.channel/)
  assert.match(source, /v-if="!props\.embedded"/)
  assert.match(source, /accountId:\s*props\.accountId/)
})

test('workbench preserves a usable center column at medium desktop widths', () => {
  const source = readSource('../../views/Workbench/WorkbenchView.vue')
  assert.match(source, /@media \(max-width: 1200px\)/)
  assert.match(source, /workbench-view__left[\s\S]*width: 300px/)
  assert.match(source, /workbench-view__right[\s\S]*width: 260px/)
})
