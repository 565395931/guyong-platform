import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCustomerWorkspace, workspaceCustomerName } from './customerWorkspace.js'

test('normalizes a partial customer context without throwing', () => {
  const result = normalizeCustomerWorkspace({
    customer: { id: 'c1' },
    permissions: { view: true },
    followups: null
  })

  assert.equal(result.customer.id, 'c1')
  assert.equal(result.stage.index, 0)
  assert.deepEqual(result.followups, [])
  assert.equal(result.permissions.view, true)
  assert.equal(result.permissions.manageFollowups, false)
})

test('preserves workspace sections and chooses a human-friendly name', () => {
  const result = normalizeCustomerWorkspace({
    customer: { display_name: 'Ada', phone: '+1' },
    activeConversation: { id: 'conv-1' },
    communicationStage: { code: 'second', index: 2, label: '二次沟通' },
    identities: [{ channel: 'whatsapp' }],
    orders: [{ id: 'o1' }]
  })

  assert.equal(result.activeConversation.id, 'conv-1')
  assert.equal(result.stage.code, 'second')
  assert.equal(result.identities.length, 1)
  assert.equal(result.orders.length, 1)
  assert.equal(workspaceCustomerName(result.customer), 'Ada')
})
