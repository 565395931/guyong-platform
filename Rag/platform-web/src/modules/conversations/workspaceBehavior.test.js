import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('list and header lifecycle actions use the same archived-state contract', () => {
  const item = source('../../components/Conversation/ConversationItem.vue')
  const chat = source('../../components/Chat/ChatWindow.vue')
  assert.match(item, /!isArchivedConversation\(conversation\) && conversation.pool_type === 'private'/)
  assert.match(chat, /v-if="canReleaseConversation\(conversation\)"/)
  assert.match(chat, /v-if="isArchivedConversation\(conversation\)"[\s\S]*?handleRevive/)
  assert.match(chat, /:disabled="sending \|\| transportReadOnly \|\| isArchivedConversation\(conversation\)"/)
})
test('workspace selection is cleared on scope changes and exit; stale deep links cannot reselect another channel', () => {
  const workbench = source('../../views/Workbench/WorkbenchView.vue')
  const page = source('../../views/PlatformMessages/PlatformMessagesView.vue')
  assert.match(workbench, /onBeforeUnmount\([\s\S]*?clearCurrent\(\)/)
  assert.match(workbench, /conversationMatchesScope[\s\S]*?flush: 'sync'/)
  assert.match(page, /requestSeq !== routeRequestSeq/)
  assert.match(page, /!conversationMatchesScope\(conversation,[\s\S]*?clearCurrent\(\)/)
})
test('local remark uses existing authorized persistence and only commits after save; no remote API is called', () => {
  const dialog = source('../../components/Conversation/CustomerRemarkDialog.vue')
  assert.match(dialog, /await updateConversation\(id, \{ user_name: userName \}\)/)
  assert.match(dialog, /if \(saving.value \|\| !editingId \|\| editingId !== props.conversation\?\.id\) return/)
  assert.match(dialog, /备注未保存，请重试/)
  assert.doesNotMatch(dialog, /provider\.thelonelybrave|localStorage|\/admin\/inbox/)
})
