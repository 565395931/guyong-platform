const { randomUUID } = require('node:crypto')

const JOB_STATUSES = new Set([
  'pending', 'processing', 'retryable_failed', 'terminal_failed', 'succeeded'
])
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,35}$/

function httpError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function queryInteger(value, fallback, minimum, maximum, field) {
  const result = Number(value ?? fallback)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw httpError(400, 'INVALID_QUERY', `${field} is invalid`)
  }
  return result
}

function normalizeProjectionJobQuery(query = {}) {
  const status = query.status == null || query.status === '' ? null : String(query.status)
  if (status && !JOB_STATUSES.has(status)) throw httpError(400, 'INVALID_QUERY', 'status is invalid')
  return Object.freeze({
    status,
    limit: queryInteger(query.limit, 20, 1, 100, 'limit'),
    offset: queryInteger(query.offset, 0, 0, 1000000, 'offset')
  })
}

function replayInput(jobId, input) {
  const id = String(jobId || '')
  const actorId = Number(input?.actorId)
  const reason = String(input?.reason || '').trim()
  if (!JOB_ID_PATTERN.test(id) || !Number.isSafeInteger(actorId) || actorId <= 0 || reason.length < 5 || reason.length > 500) {
    throw httpError(400, 'INVALID_REPLAY', 'Replay input is invalid')
  }
  return Object.freeze({ id, actorId, reason })
}

function createCommerceProjectionAdminRepository(sequelize, { createAuditId = randomUUID } = {}) {
  if (!sequelize || typeof sequelize.query !== 'function' || typeof sequelize.transaction !== 'function') {
    throw new TypeError('Commerce projection admin repository requires Sequelize')
  }
  return Object.freeze({
    async list(filters) {
      const where = filters.status ? 'WHERE status=:status' : ''
      const replacements = filters.status ? { status: filters.status } : {}
      const [itemsResult, countResult] = await Promise.all([
        sequelize.query(
          `SELECT id, event_inbox_id, channel, account_id, external_order_id, external_version,
                  status, attempts, next_attempt_at, last_error_code, last_error_message,
                  created_at, updated_at
             FROM commerce_projection_jobs
             ${where}
            ORDER BY created_at DESC, id DESC
            LIMIT :limit OFFSET :offset`,
          { replacements: { ...replacements, limit: filters.limit, offset: filters.offset } }
        ),
        sequelize.query(
          `SELECT COUNT(*) AS total FROM commerce_projection_jobs ${where}`,
          { replacements }
        )
      ])
      return Object.freeze({
        items: itemsResult[0],
        total: Number(countResult[0][0]?.total || 0),
        limit: filters.limit,
        offset: filters.offset
      })
    },

    async replay(jobId, input) {
      const replay = replayInput(jobId, input)
      return sequelize.transaction(async transaction => {
        const [rows] = await sequelize.query(
          `SELECT id, status
             FROM commerce_projection_jobs
            WHERE id=:id
            LIMIT 1
            FOR UPDATE`,
          { replacements: { id: replay.id }, transaction }
        )
        const job = rows[0]
        if (!job) throw httpError(404, 'JOB_NOT_FOUND', 'Projection job does not exist')
        if (job.status !== 'terminal_failed') {
          throw httpError(409, 'JOB_NOT_REPLAYABLE', 'Projection job is not terminal')
        }
        await sequelize.query(
          `UPDATE commerce_projection_jobs
              SET status='retryable_failed', next_attempt_at=NOW(3), locked_at=NULL,
                  last_error_code=NULL, last_error_message=NULL, updated_at=NOW()
            WHERE id=:id AND status='terminal_failed'`,
          { replacements: { id: replay.id }, transaction }
        )
        await sequelize.query(
          `INSERT INTO commerce_projection_audit_logs
            (id, job_id, actor_id, action, before_status, after_status, reason, created_at)
           VALUES
            (:id, :jobId, :actorId, :action, :beforeStatus, :afterStatus, :reason, NOW(3))`,
          {
            replacements: {
              id: createAuditId(),
              jobId: replay.id,
              actorId: replay.actorId,
              action: 'manual_replay',
              beforeStatus: 'terminal_failed',
              afterStatus: 'retryable_failed',
              reason: replay.reason
            },
            transaction
          }
        )
        return Object.freeze({ id: replay.id, status: 'retryable_failed' })
      })
    }
  })
}

module.exports = {
  createCommerceProjectionAdminRepository,
  normalizeProjectionJobQuery,
  replayInput
}

