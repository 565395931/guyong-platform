const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
const MAX_STRING_LENGTH = 1000
const REDACTED = '[REDACTED]'
let lastCleanupDate = null

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatLocalDateTime(date = new Date()) {
  return `${formatLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function shouldRedact(key = '') {
  return /authorization|cookie|token|secret|password|apikey|api_key|key/i.test(key)
}

function sanitize(value, depth = 0, key = '') {
  if (shouldRedact(key)) return REDACTED
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    }
  }
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}]`
  if (depth >= 5) return '[MaxDepth]'
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitize(item, depth + 1))
  }
  if (typeof value === 'object') {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitize(childValue, depth + 1, childKey)
    }
    return output
  }
  return String(value)
}

function write(level, event, data = {}) {
  const now = new Date()
  const entry = {
    ts: now.toISOString(),
    localTs: formatLocalDateTime(now),
    level,
    event,
    pid: process.pid,
    data: sanitize(data)
  }

  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    cleanupOldLogs(now)
    const filePath = path.join(LOG_DIR, `system-${formatLocalDate(now)}.log`)
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    console.error('[SystemLogger] write failed:', err.message)
  }
}

function cleanupOldLogs(now = new Date()) {
  const today = formatLocalDate(now)
  if (lastCleanupDate === today) return
  lastCleanupDate = today

  const retentionDays = Math.max(parseInt(process.env.SYSTEM_LOG_RETENTION_DAYS || '14', 10) || 14, 1)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const fileName of fs.readdirSync(LOG_DIR)) {
    const match = fileName.match(/^system-(\d{4})-(\d{2})-(\d{2})\.log$/)
    if (!match) continue
    const fileTime = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`).getTime()
    if (Number.isFinite(fileTime) && fileTime < cutoff) {
      fs.unlinkSync(path.join(LOG_DIR, fileName))
    }
  }
}

function info(event, data) {
  write('INFO', event, data)
}

function warn(event, data) {
  write('WARN', event, data)
}

function error(event, data) {
  write('ERROR', event, data)
}

function maskValue(value) {
  if (value === null || value === undefined) return value
  const text = String(value)
  if (text.length <= 8) return text
  return `${text.slice(0, 3)}***${text.slice(-4)}`
}

module.exports = {
  info,
  warn,
  error,
  maskValue
}
