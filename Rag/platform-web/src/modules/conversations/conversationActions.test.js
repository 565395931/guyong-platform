import test from 'node:test'
import assert from 'node:assert/strict'
import { isArchivedConversation, canReleaseConversation } from './conversationActions.js'

test('archived private/long-term records expose restore instead of release', () => {
  for (const pool_type of ['private', 'long_term']) {
    const conversation = { pool_type, conv_status: 'archived' }
    assert.equal(isArchivedConversation(conversation), true)
    assert.equal(canReleaseConversation(conversation), false)
    assert.equal(canReleaseConversation({ pool_type, conv_status: 'human_serving' }), true)
  }
})
test('closed and archived pool records are archived regardless of stale pool/status', () => {
  assert.equal(canReleaseConversation({ pool_type: 'private', status: 'closed' }), false)
  assert.equal(isArchivedConversation({ pool_type: 'archived' }), true)
})
