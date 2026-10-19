const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const source = readFileSync(__dirname + '/conversations.js', 'utf8')

test('conversation routes use shared authentication without accepting a fallback secret', () => {
  assert.match(source, /createAuthenticate/)
  assert.doesNotMatch(source, /EFFECTIVE_JWT_SECRET|_dev_only/)
})

test('ordinary agents cannot reassign conversations through legacy update and assign routes', () => {
  const updateBlock = source.match(/router\.patch\('\/:id',[\s\S]*?router\.post\('\/:id\/infer-nationality'/)?.[0] || ''
  const assignBlock = source.match(/router\.post\('\/:id\/assign',[\s\S]*?router\.post\('\/:id\/fetch-avatar'/)?.[0] || ''

  assert.match(updateBlock, /agent_id !== undefined[\s\S]*admin/)
  assert.match(assignBlock, /admin/)
  assert.match(updateBlock, /findActiveAgent/)
  assert.match(assignBlock, /findActiveAgent/)
})

test('conversation object authorization does not reveal foreign object existence', () => {
  const accessBlock = source.match(/async function requireConversationAccess[\s\S]*?async function getLatestInboundCustomerMessage/)?.[0] || ''
  assert.doesNotMatch(accessBlock, /status\(403\)/)
  assert.match(accessBlock, /status\(404\)/)
})

test('ordinary agents use shared bound-account AI/history/assignment visibility', () => {
 const visibilityBlock=source.match(/function addAgentVisibilityCondition[\s\S]*?async function checkConversationAccess/)?.[0]||''
 assert.match(visibilityBlock,/workspacePolicy/)
 const {agentVisibility}=require('../modules/conversation-pool/workspacePolicy')
 assert.match(agentVisibility(),/seat_account_bindings/)
 assert.match(agentVisibility(),/pool_type = 'ai_self'/)
 assert.match(agentVisibility(),/conversation_seat_history/)
})

test('transfer validates an active target agent before changing ownership', () => {
  const transferBlock = source.match(/router\.post\('\/:id\/transfer',[\s\S]*?module\.exports/)?.[0] || ''
  assert.match(transferBlock, /findActiveAgent/)
})

test('global side-effect routes require privileged authorization', () => {
  const batchAvatarBlock = source.match(/router\.post\('\/batch-fetch-avatars',[\s\S]*?router\.post\('\/:id\/sync-history'/)?.[0] || ''
  const syncAllStart = source.indexOf("router.post('/sync-all-history'")
  const syncAllEnd = source.indexOf("router.get('/sync-all-history/jobs/:jobId'", syncAllStart)
  const syncAllBlock = syncAllStart >= 0 && syncAllEnd > syncAllStart
    ? source.slice(syncAllStart, syncAllEnd)
    : ''

  assert.match(batchAvatarBlock, /admin/)
  assert.match(syncAllBlock, /admin/)
  assert.match(batchAvatarBlock, /requirePrivilegedAccountScope/)
  assert.match(syncAllBlock, /requirePrivilegedAccountScope/)
  assert.match(batchAvatarBlock, /enforcePrivilegedActionRateLimit/)
  assert.match(syncAllBlock, /enforcePrivilegedActionRateLimit/)
  assert.match(batchAvatarBlock, /logPoolAction/)
  assert.match(syncAllBlock, /logPoolAction/)
  assert.match(batchAvatarBlock, /boundedInteger/)
  assert.match(syncAllBlock, /boundedInteger/)
  assert.match(batchAvatarBlock, /acquireSharedLease/)
  assert.match(syncAllBlock, /acquireSharedLease/)
})
