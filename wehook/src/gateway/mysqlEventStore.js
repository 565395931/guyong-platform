const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { isDeepStrictEqual } = require('util')

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function dateValue(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function toMysqlDateTime(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) throw new Error('invalid event timestamp')
  return date.toISOString().slice(0, 23).replace('T', ' ')
}

function safeLimit(value, fallback = 100) {
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000000) : fallback
}

class MySqlEventStore {
  constructor(config) {
    this.config = config
    this.instanceId = crypto.randomUUID()
    this.pool = null
    this.ready = null
  }

  async _ensureReady() {
    if (!this.ready) this.ready = this._initialize()
    return this.ready
  }

  async _initialize() {
    if (!this.config?.name || !this.config?.user) {
      throw new Error('GATEWAY_DB_NAME and GATEWAY_DB_USER are required when GATEWAY_STORE_DRIVER=mysql')
    }
    let mysql
    try { mysql = require('mysql2/promise') } catch {
      throw new Error('MySQL Store requires the mysql2 dependency. Run pnpm install before enabling it.')
    }
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.name,
      user: this.config.user,
      password: this.config.password || '',
      waitForConnections: true,
      connectionLimit: this.config.poolMax || 10,
      maxIdle: this.config.poolMax || 10,
      idleTimeout: 60000,
      enableKeepAlive: true,
      timezone: 'Z',
      ssl: this.config.ssl ? {} : undefined
    })
    const schemaPath = path.join(__dirname, 'mysql-schema.sql')
    const statements = fs.readFileSync(schemaPath, 'utf8')
      .split(';')
      .map(statement => statement.trim())
      .filter(Boolean)
    const connection = await this.pool.getConnection()
    try {
      for (const statement of statements) await connection.query(statement)
    } finally {
      connection.release()
    }
  }

  async _query(sql, params = []) {
    await this._ensureReady()
    return this.pool.execute(sql, params)
  }

  _rowToEvent(row) {
    if (!row) return null
    return {
      protocolVersion: row.protocol_version,
      type: row.event_type,
      eventId: row.event_id,
      occurredAt: dateValue(row.occurred_at),
      sentAt: dateValue(row.sent_at),
      payload: parseJson(row.payload_json, {}),
      sequence: Number(row.sequence),
      status: row.delivery_status,
      deliveryAttempt: Number(row.delivery_attempt || 0),
      lastAttemptAt: dateValue(row.last_attempt_at),
      lastError: row.last_error || null,
      ackStatus: row.ack_status || null,
      ackResult: parseJson(row.ack_result_json, null),
      ackAt: dateValue(row.ack_at),
      deadLetterReason: row.dead_letter_reason || null,
      deadLetterAt: dateValue(row.dead_letter_at),
      createdAt: dateValue(row.created_at)
    }
  }

  async _getEventRow(connection, eventId, lock = false) {
    const suffix = lock ? ' FOR UPDATE' : ''
    const [rows] = await connection.execute('SELECT * FROM gateway_events WHERE event_id = ?' + suffix, [eventId])
    return rows[0] || null
  }

  async appendEvent(envelope) {
    if (!envelope?.eventId) throw new Error('eventId is required')
    await this._ensureReady()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [insert] = await connection.execute(
        'INSERT IGNORE INTO gateway_events (event_id, protocol_version, event_type, occurred_at, sent_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        [envelope.eventId, envelope.protocolVersion, envelope.type, toMysqlDateTime(envelope.occurredAt), toMysqlDateTime(envelope.sentAt), JSON.stringify(envelope.payload || {})]
      )
      const row = await this._getEventRow(connection, envelope.eventId, true)
      if (!row) throw new Error('event insert failed')
      const existingPayload = parseJson(row.payload_json, {})
      if (row.event_type !== envelope.type || !isDeepStrictEqual(existingPayload, envelope.payload || {})) {
        const error = new Error('eventId already exists with a different payload')
        error.code = 'event_id_conflict'
        throw error
      }
      await connection.commit()
      return { ...this._rowToEvent(row), duplicate: insert.affectedRows === 0 }
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async listPending({ limit = 100 } = {}) {
    const safe = safeLimit(limit)
    await this._ensureReady()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [claimed] = await connection.query(
        "SELECT event_id FROM gateway_events WHERE delivery_status = 'pending' AND (lease_until IS NULL OR lease_until < UTC_TIMESTAMP(3) OR lease_owner = ?) ORDER BY sequence ASC LIMIT " + safe + ' FOR UPDATE SKIP LOCKED',
        [this.instanceId]
      )
      if (!claimed.length) {
        await connection.commit()
        return []
      }
      const ids = claimed.map(row => row.event_id)
      const placeholders = ids.map(() => '?').join(',')
      const leaseUntil = toMysqlDateTime(Date.now() + (this.config.leaseMs || 60000))
      await connection.execute(
        'UPDATE gateway_events SET lease_owner = ?, lease_until = ? WHERE event_id IN (' + placeholders + ')',
        [this.instanceId, leaseUntil, ...ids]
      )
      const [rows] = await connection.execute(
        'SELECT * FROM gateway_events WHERE event_id IN (' + placeholders + ') ORDER BY sequence ASC',
        ids
      )
      await connection.commit()
      return rows.map(row => this._rowToEvent(row))
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async getEvent(eventId) {
    const [rows] = await this._query('SELECT * FROM gateway_events WHERE event_id = ?', [eventId])
    return this._rowToEvent(rows[0])
  }

  async markAttempt(eventId, details = {}) {
    await this._ensureReady()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [update] = await connection.execute(
        'UPDATE gateway_events SET delivery_attempt = delivery_attempt + 1, last_attempt_at = UTC_TIMESTAMP(3), last_error = ?, lease_owner = ?, lease_until = ? WHERE event_id = ?',
        [details.error || null, this.instanceId, toMysqlDateTime(Date.now() + (this.config.leaseMs || 60000)), eventId]
      )
      if (!update.affectedRows) {
        await connection.rollback()
        return null
      }
      const row = await this._getEventRow(connection, eventId, true)
      await connection.execute(
        'INSERT INTO gateway_delivery_attempts (event_id, attempt, replayed, client_id, error_message) VALUES (?, ?, ?, ?, ?)',
        [eventId, row.delivery_attempt, details.replayed ? 1 : 0, details.clientId || null, details.error || null]
      )
      await connection.commit()
      return this._rowToEvent(row)
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async _recomputeCursor(connection) {
    const [rows] = await connection.execute('SELECT sequence, delivery_status FROM gateway_events ORDER BY sequence ASC')
    let cursor = 0
    for (const row of rows) {
      if (!['processed', 'duplicate', 'rejected', 'dead_letter'].includes(row.delivery_status)) break
      cursor = Number(row.sequence)
    }
    await connection.execute(
      "INSERT INTO gateway_meta (meta_key, meta_value) VALUES ('cursor', ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)",
      [String(cursor)]
    )
    return cursor
  }

  async acknowledge(eventId, status, result) {
    await this._ensureReady()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this._getEventRow(connection, eventId, true)
      if (!row) {
        await connection.rollback()
        return null
      }
      if (row.delivery_status === 'dead_letter' ||
        (['processed', 'duplicate', 'rejected'].includes(row.delivery_status) && status === 'retryable_error')) {
        await connection.rollback()
        return this._rowToEvent(row)
      }
      const nextStatus = ['processed', 'duplicate', 'rejected'].includes(status) ? status : row.delivery_status
      await connection.execute(
        "UPDATE gateway_events SET delivery_status = ?, ack_status = ?, ack_result_json = ?, ack_at = UTC_TIMESTAMP(3), lease_owner = IF(? = 'pending', lease_owner, NULL), lease_until = IF(? = 'pending', lease_until, NULL) WHERE event_id = ?",
        [nextStatus, status, result ? JSON.stringify(result) : null, nextStatus, nextStatus, eventId]
      )
      await this._recomputeCursor(connection)
      const updated = await this._getEventRow(connection, eventId)
      await connection.commit()
      return this._rowToEvent(updated)
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async deadLetter(eventId, reason) {
    await this._ensureReady()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this._getEventRow(connection, eventId, true)
      if (!row) {
        await connection.rollback()
        return null
      }
      if (row.delivery_status === 'dead_letter') {
        await connection.rollback()
        return this._rowToEvent(row)
      }
      await connection.execute(
        "UPDATE gateway_events SET delivery_status = 'dead_letter', dead_letter_reason = ?, dead_letter_at = UTC_TIMESTAMP(3), lease_owner = NULL, lease_until = NULL WHERE event_id = ?",
        [reason, eventId]
      )
      await connection.execute(
        'INSERT IGNORE INTO gateway_dead_letters (event_id, event_type, sequence, reason) VALUES (?, ?, ?, ?)',
        [eventId, row.event_type, row.sequence, reason]
      )
      await this._recomputeCursor(connection)
      const updated = await this._getEventRow(connection, eventId)
      await connection.commit()
      return this._rowToEvent(updated)
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async putCommand(commandId, value) {
    const payload = value?.payload || {}
    const result = value?.result || null
    const [insert] = await this._query(
      'INSERT IGNORE INTO gateway_commands (command_id, payload_json, result_json) VALUES (?, ?, ?)',
      [commandId, JSON.stringify(payload), result ? JSON.stringify(result) : null]
    )
    const existing = await this.getCommand(commandId)
    if (!existing) throw new Error('command insert failed')
    if (insert.affectedRows === 0 && !isDeepStrictEqual(existing.payload, payload)) {
      const error = new Error('commandId already exists with a different payload')
      error.code = 'command_id_conflict'
      throw error
    }
    return { ...existing, duplicate: insert.affectedRows === 0 }
  }

  async updateCommand(commandId, value) {
    const existing = await this.getCommand(commandId)
    if (!existing) return this.putCommand(commandId, value)
    const payload = value?.payload || existing.payload || {}
    if (!isDeepStrictEqual(existing.payload, payload)) {
      const error = new Error('commandId already exists with a different payload')
      error.code = 'command_id_conflict'
      throw error
    }
    const result = value?.result === undefined ? existing.result : value.result
    await this._query(
      'UPDATE gateway_commands SET payload_json = ?, result_json = ? WHERE command_id = ?',
      [JSON.stringify(payload), result ? JSON.stringify(result) : null, commandId]
    )
    return this.getCommand(commandId)
  }

  async getCommand(commandId) {
    const [rows] = await this._query('SELECT * FROM gateway_commands WHERE command_id = ?', [commandId])
    const row = rows[0]
    if (!row) return null
    return {
      commandId: row.command_id,
      payload: parseJson(row.payload_json, {}),
      result: parseJson(row.result_json, null),
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at)
    }
  }

  async listDeadLetters({ afterCursor = 0, limit = 100 } = {}) {
    const safe = safeLimit(limit)
    const cursor = Number.isSafeInteger(Number(afterCursor)) ? Number(afterCursor) : 0
    const [rows] = await this._query(
      'SELECT event_id, event_type, sequence, reason, created_at FROM gateway_dead_letters WHERE sequence > ? ORDER BY sequence ASC LIMIT ' + safe,
      [cursor]
    )
    return rows.map(row => ({
      eventId: row.event_id,
      eventType: row.event_type,
      sequence: Number(row.sequence),
      reason: row.reason,
      createdAt: dateValue(row.created_at)
    }))
  }

  async getCursor() {
    const [rows] = await this._query("SELECT meta_value FROM gateway_meta WHERE meta_key = 'cursor'")
    return Number(rows[0]?.meta_value || 0)
  }

  async stats() {
    const [rows] = await this._query(
      "SELECT SUM(delivery_status = 'pending') AS pendingEvents, SUM(delivery_status IN ('processed', 'duplicate', 'rejected')) AS acknowledgedEvents FROM gateway_events"
    )
    const [dead] = await this._query('SELECT COUNT(*) AS count FROM gateway_dead_letters')
    const [commands] = await this._query('SELECT COUNT(*) AS count FROM gateway_commands')
    const [attempts] = await this._query('SELECT COUNT(*) AS count FROM gateway_delivery_attempts')
    return {
      pendingEvents: Number(rows[0]?.pendingEvents || 0),
      acknowledgedEvents: Number(rows[0]?.acknowledgedEvents || 0),
      deadLetters: Number(dead[0]?.count || 0),
      commands: Number(commands[0]?.count || 0),
      deliveryAttempts: Number(attempts[0]?.count || 0)
    }
  }

  async close() {
    await this.ready?.catch(() => {})
    if (this.pool) {
      await this.pool.execute(
        "UPDATE gateway_events SET lease_owner = NULL, lease_until = NULL WHERE delivery_status = 'pending' AND lease_owner = ?",
        [this.instanceId]
      ).catch(() => {})
    }
    await this.pool?.end()
    this.pool = null
  }
}

module.exports = MySqlEventStore
