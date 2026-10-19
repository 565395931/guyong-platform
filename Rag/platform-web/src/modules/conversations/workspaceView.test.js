import test from 'node:test'
import assert from 'node:assert/strict'
import { fitsWorkspaceTab, isMine } from './workspaceView.js'

test('a replied customer stays in My while AI is replying, then leaves active tabs on archive', () => {
  const user = { id: 2, role: 'agent' }
  const conversation = { pool_type: 'ai_self', conv_status: 'ai_serving', status: 'open', participant_seat_ids: [2] }
  assert.equal(isMine(conversation, user), true)
  assert.equal(fitsWorkspaceTab(conversation, 'private', user), true)
  assert.equal(fitsWorkspaceTab(conversation, 'ai_self', user), true)
  conversation.status = 'closed'
  assert.equal(fitsWorkspaceTab(conversation, 'pending_human', user), false)
  assert.equal(fitsWorkspaceTab(conversation, 'private', user), false)
  assert.equal(fitsWorkspaceTab(conversation, 'archived', user), true)
})
test('ordinary seats see only their assigned pending customers; Admin sees all pending', () => {
  const conversation = { pool_type: 'pending_human', conv_status: 'pending_claim', status: 'open', agent_id: 2 }
  assert.equal(fitsWorkspaceTab(conversation, 'pending_human', { id: 2, role: 'agent' }), true)
  assert.equal(fitsWorkspaceTab(conversation, 'pending_human', { id: 3, role: 'agent' }), false)
  assert.equal(fitsWorkspaceTab(conversation, 'pending_human', { id: 1, role: 'admin' }), true)
})
test('legacy long-term rows are included in My and archived stale-pool rows never show in pending', () => {
  assert.equal(fitsWorkspaceTab({ pool_type: 'long_term', status: 'open', claimed_by: 2 }, 'private', { id: 2, role: 'agent' }), true)
  assert.equal(fitsWorkspaceTab({ pool_type: 'pending_human', status: 'closed', conv_status: 'pending_claim' }, 'pending_human', { role: 'admin' }), false)
})
