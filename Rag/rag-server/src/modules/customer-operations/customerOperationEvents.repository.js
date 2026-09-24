const crypto = require('crypto')
const { sequelize: defaultSequelize } = require('../../config/database')

function createCustomerOperationEventsRepository({ sequelize = defaultSequelize } = {}) {
  async function enqueue(input, transaction) {
    return sequelize.query(
      `INSERT INTO customer_operation_events
        (id, event_key, event_type, payload, status, attempts, available_at, created_at, updated_at)
       VALUES (:id, :eventKey, :eventType, CAST(:payload AS JSON), 'pending', 0, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE event_key = event_key`,
      { replacements: { id: input.id || crypto.randomUUID(), eventKey: input.eventKey, eventType: input.eventType, payload: JSON.stringify(input.payload || {}) }, transaction }
    )
  }

  async function claimBatch({ workerId, limit = 20, leaseUntil }, transaction) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100)
    const [rows] = await sequelize.query(
      `SELECT id FROM customer_operation_events
       WHERE status IN ('pending', 'retry') AND available_at <= NOW()
         AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY available_at, created_at LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { replacements: { limit: boundedLimit }, transaction }
    )
    const ids = rows.map(row => row.id)
    if (!ids.length) return []
    await sequelize.query(
      `UPDATE customer_operation_events
       SET status='processing', worker_id=:workerId, lease_until=:leaseUntil, updated_at=NOW()
       WHERE id IN (:ids)`,
      { replacements: { workerId, leaseUntil, ids }, transaction }
    )
    return ids
  }

  async function complete(id, transaction) {
    return sequelize.query(
      `UPDATE customer_operation_events
       SET status='completed', worker_id=NULL, lease_until=NULL, updated_at=NOW() WHERE id=:id`,
      { replacements: { id }, transaction }
    )
  }

  async function retry(id, errorCode, availableAt, transaction) {
    return sequelize.query(
      `UPDATE customer_operation_events
       SET status='retry', attempts=attempts+1, last_error_code=:errorCode,
           available_at=:availableAt, worker_id=NULL, lease_until=NULL, updated_at=NOW()
       WHERE id=:id`,
      { replacements: { id, errorCode, availableAt }, transaction }
    )
  }

  return { enqueue, claimBatch, complete, retry }
}

module.exports = { createCustomerOperationEventsRepository }
