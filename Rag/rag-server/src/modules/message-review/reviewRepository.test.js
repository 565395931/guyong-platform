const test = require('node:test')
const assert = require('node:assert/strict')

const { createReviewRepository } = require('./reviewRepository')

function createRecordingSequelize(handler = async () => [[], {}]) {
  const calls = []
  return {
    calls,
    query: async (sql, options = {}) => {
      const call = { sql: sql.replace(/\s+/g, ' ').trim(), options }
      calls.push(call)
      return handler(call, calls)
    }
  }
}

test('creates idempotently by primary_message_id and serializes JSON fields', async () => {
  const db = createRecordingSequelize(async (call) => {
    if (call.sql.startsWith('UPDATE message_review_items')) return [{ affectedRows: 0 }, {}]
    if (call.sql.startsWith('SELECT')) return [[{ id: 'r1', status: 'pending' }], {}]
    return [{ affectedRows: 1 }, {}]
  })
  const repository = createReviewRepository(db)

  const item = await repository.createOrMerge({
    conversationId: 'c1',
    messageId: 'm1',
    riskLevel: 'high',
    confidence: 0.4,
    reasonCode: 'prompt_injection',
    reasonText: 'Instruction override attempt',
    recommendedAction: 'review',
    ruleHits: ['prompt_injection'],
    modelName: 'review-model',
    assignedTo: 7,
    mergeWindowSeconds: 30
  })

  assert.equal(item.id, 'r1')
  const insert = db.calls.find((call) => call.sql.startsWith('INSERT INTO message_review_items'))
  assert.match(insert.sql, /primary_message_id/)
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/)
  assert.equal(insert.options.replacements.messageIds, '["m1"]')
  assert.equal(insert.options.replacements.ruleHits, '["prompt_injection"]')
})

test('merges only into an unclaimed pending item inside the configured window', async () => {
  const db = createRecordingSequelize(async (call) => {
    if (call.sql.startsWith('UPDATE message_review_items')) return [{ affectedRows: 1 }, {}]
    if (call.sql.startsWith('SELECT')) return [[{ id: 'r1', status: 'pending' }], {}]
    return [[], {}]
  })
  const repository = createReviewRepository(db)

  await repository.createOrMerge({
    conversationId: 'c1', messageId: 'm2', riskLevel: 'medium', reasonCode: 'ambiguous',
    reasonText: 'Needs context', recommendedAction: 'review', ruleHits: [], mergeWindowSeconds: 30
  })

  const merge = db.calls.find((call) => call.sql.startsWith('UPDATE message_review_items'))
  assert.match(merge.sql, /status='pending'/)
  assert.match(merge.sql, /claimed_by IS NULL/)
  assert.match(merge.sql, /created_at >= :mergeCutoff/)
  assert.ok(merge.options.replacements.mergeCutoff instanceof Date)
  assert.equal(db.calls.some((call) => call.sql.startsWith('INSERT')), false)
})

test('claim is atomic and reports a conflict when no pending row is updated', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 0 }, {}])
  const repository = createReviewRepository(db)

  await assert.rejects(repository.claim('r1', 9), (error) => error.code === 'REVIEW_CONFLICT')
  const update = db.calls[0]
  assert.match(update.sql, /WHERE id=:id AND status='pending'/)
  assert.match(update.sql, /assigned_to IS NULL OR assigned_to=:operatorId/)
})

test('privileged claim can take any pending task while recording the actual operator', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 1 }, {}])
  const repository = createReviewRepository(db)
  await repository.claim('r1', 9, { privileged: true })
  assert.doesNotMatch(db.calls[0].sql, /assigned_to IS NULL/)
  assert.equal(db.calls[0].options.replacements.operatorId, 9)
})

test('privileged release can return another operators claimed task to the queue', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 1 }, {}])
  const repository = createReviewRepository(db)

  await repository.release('r1', 9, { privileged: true })

  assert.match(db.calls[0].sql, /status='claimed'/)
  assert.doesNotMatch(db.calls[0].sql, /claimed_by=:operatorId/)
})

test('agent release remains restricted to work claimed by that agent', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 1 }, {}])
  const repository = createReviewRepository(db)

  await repository.release('r1', 9)

  assert.match(db.calls[0].sql, /claimed_by=:operatorId/)
})

test('takeover atomically transfers a claimed task to the privileged operator', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 1 }, {}])
  const repository = createReviewRepository(db)

  await repository.takeover('r1', 9)

  assert.match(db.calls[0].sql, /SET claimed_by=:operatorId/)
  assert.match(db.calls[0].sql, /status='claimed'/)
  assert.match(db.calls[0].sql, /claimed_by<>:operatorId/)
})

test('resolve operations require the item to be claimed by the acting operator', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 1 }, {}])
  const repository = createReviewRepository(db)

  await repository.resolveReply('r1', 9, 'out-1')
  await repository.resolveDismiss('r2', 9, 'spam')

  assert.match(db.calls[0].sql, /status='claimed' AND claimed_by=:operatorId/)
  assert.match(db.calls[0].sql, /status='replied'/)
  assert.match(db.calls[1].sql, /status='dismissed'/)
  assert.equal(db.calls[1].options.replacements.resolutionReason, 'spam')
})

test('agent list scopes are always restricted and all scope is privileged', async () => {
  const db = createRecordingSequelize(async () => [[], {}])
  const repository = createReviewRepository(db)

  await repository.list({ scope: 'mine', operatorId: 5, role: 'agent', limit: 20, offset: 0 })
  assert.match(db.calls[0].sql, /r\.assigned_to=:operatorId OR r\.claimed_by=:operatorId/)

  await assert.rejects(
    repository.list({ scope: 'all', operatorId: 5, role: 'agent', limit: 20, offset: 0 }),
    (error) => error.code === 'REVIEW_FORBIDDEN'
  )
})

test('expired owner assignments return to the public pool without touching claimed work', async () => {
  const db = createRecordingSequelize(async () => [{ affectedRows: 2 }, {}])
  const repository = createReviewRepository(db)
  assert.equal(await repository.releaseExpiredAssignments(300), 2)
  assert.match(db.calls[0].sql, /status='pending'/)
  assert.match(db.calls[0].sql, /claimed_by IS NULL/)
  assert.match(db.calls[0].sql, /assigned_to=NULL/)
  assert.match(db.calls[0].sql, /updated_at < :assignmentCutoff/)
  assert.ok(db.calls[0].options.replacements.assignmentCutoff instanceof Date)
  const elapsed = Date.now() - db.calls[0].options.replacements.assignmentCutoff.getTime()
  assert.ok(elapsed >= 299_000 && elapsed <= 301_000)
})
