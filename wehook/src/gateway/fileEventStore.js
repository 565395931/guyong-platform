const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { isDeepStrictEqual } = require('util')

function clone(value) { return JSON.parse(JSON.stringify(value)) }

class FileEventStore {
  constructor(filePath) {
    this.filePath = filePath
    this.state = { events: [], commands: [], attempts: [], deadLetters: [], cursor: 0 }
    this._load()
  }

  _load() {
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    fs.renameSync(tmp, this.filePath)
  }

  appendEvent(envelope) {
    if (!envelope?.eventId) throw new Error('eventId is required')
    const existing = this.state.events.find(event => event.eventId === envelope.eventId)
    if (existing) {
      if (existing.type !== envelope.type || !isDeepStrictEqual(existing.payload, envelope.payload)) {
        const error = new Error('eventId already exists with a different payload')
        error.code = 'event_id_conflict'
        throw error
      }
      return { ...clone(existing), duplicate: true }
    }
    const record = { ...clone(envelope), sequence: this.state.events.length + 1, status: 'pending', deliveryAttempt: 0, createdAt: new Date().toISOString() }
    this.state.events.push(record)
    this._save()
    return clone(record)
  }

  listPending({ afterCursor = 0, limit = 100 } = {}) {
    return this.state.events
      // 未确认事件必须始终重放；游标只用于跳过已确认历史，不能遮蔽低序号 pending 事件。
      .filter(event => event.status === 'pending')
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(clone)
  }

  getEvent(eventId) { return clone(this.state.events.find(event => event.eventId === eventId) || null) }

  markAttempt(eventId, details = {}) {
    const event = this.state.events.find(item => item.eventId === eventId)
    if (!event) return null
    event.deliveryAttempt += 1
    event.lastAttemptAt = new Date().toISOString()
    event.lastError = details.error || null
    this.state.attempts.push({ id: crypto.randomUUID(), eventId, attempt: event.deliveryAttempt, ...details, createdAt: new Date().toISOString() })
    this._save()
    return clone(event)
  }

  acknowledge(eventId, status, result) {
    const event = this.state.events.find(item => item.eventId === eventId)
    if (!event) return null
    const terminal = ['processed', 'duplicate', 'rejected', 'dead_letter']
    // 终态不能被迟到的 retryable_error 覆盖；ACK 丢失/乱序时保留第一次终态。
    if (event.status === 'dead_letter' || (terminal.includes(event.status) && status === 'retryable_error')) {
      return clone(event)
    }
    if (['processed', 'duplicate', 'rejected'].includes(status)) event.status = status
    event.ackStatus = status
    event.ackResult = result || null
    event.ackAt = new Date().toISOString()
    this._recomputeCursor()
    this._save()
    return clone(event)
  }

  deadLetter(eventId, reason) {
    const event = this.state.events.find(item => item.eventId === eventId)
    if (!event) return null
    if (event.status === 'dead_letter') return clone(event)
    event.status = 'dead_letter'
    event.deadLetterReason = reason
    event.deadLetterAt = new Date().toISOString()
    this.state.deadLetters.push({ eventId, eventType: event.type, sequence: event.sequence, reason, createdAt: event.deadLetterAt })
    this._recomputeCursor()
    this._save()
    return clone(event)
  }

  _recomputeCursor() {
    // 游标只前进到连续终态，不能跨过低序号 pending 事件。未确认事件仍由
    // listPending() 重放，因此游标只是已连续确认历史的压缩标记。
    const bySequence = new Map(this.state.events.map(event => [event.sequence, event]))
    let cursor = 0
    while (true) {
      const next = bySequence.get(cursor + 1)
      if (!next || !['processed', 'duplicate', 'rejected', 'dead_letter'].includes(next.status)) break
      cursor = next.sequence
    }
    this.state.cursor = cursor
  }

  putCommand(commandId, value) {
    const existing = this.state.commands.find(command => command.commandId === commandId)
    if (existing) return { ...clone(existing), duplicate: true }
    const record = { commandId, ...clone(value), createdAt: new Date().toISOString() }
    this.state.commands.push(record)
    this._save()
    return clone(record)
  }

  updateCommand(commandId, value) {
    const command = this.state.commands.find(item => item.commandId === commandId)
    if (!command) return this.putCommand(commandId, value)
    Object.assign(command, clone(value), { updatedAt: new Date().toISOString() })
    this._save()
    return clone(command)
  }

  getCommand(commandId) { return clone(this.state.commands.find(command => command.commandId === commandId) || null) }

  listDeadLetters({ afterCursor = 0, limit = 100 } = {}) {
    return this.state.deadLetters
      .filter(record => !record.sequence || record.sequence > afterCursor)
      .slice(0, limit)
      .map(clone)
  }
  getCursor() { return this.state.cursor || 0 }
  stats() {
    return {
      pendingEvents: this.state.events.filter(event => event.status === 'pending').length,
      acknowledgedEvents: this.state.events.filter(event => ['processed', 'duplicate', 'rejected'].includes(event.status)).length,
      deadLetters: this.state.deadLetters.length,
      commands: this.state.commands.length,
      deliveryAttempts: this.state.attempts.length
    }
  }
}

module.exports = FileEventStore
