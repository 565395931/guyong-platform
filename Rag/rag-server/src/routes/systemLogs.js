const express = require('express')
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

const router = express.Router()

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 200
const MAX_READ_BYTES = 5 * 1024 * 1024
const JWT_SECRET = process.env.JWT_SECRET
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'

router.use((req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ success: false, message: 'Authentication token is required' })

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins can view system logs' })
    }
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: `Authentication failed: ${err.message}` })
  }
})

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '')
}

function resolveLogFile(date) {
  const safeDate = isValidDate(date) ? date : new Date().toISOString().slice(0, 10)
  return {
    date: safeDate,
    filePath: path.join(LOG_DIR, `system-${safeDate}.log`)
  }
}

function readTail(filePath, maxBytes = MAX_READ_BYTES) {
  if (!fs.existsSync(filePath)) return ''

  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - maxBytes)
  const length = stat.size - start
  const fd = fs.openSync(filePath, 'r')

  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return {
      ts: null,
      localTs: null,
      level: 'RAW',
      event: 'raw.line',
      pid: null,
      data: { raw: line }
    }
  }
}

router.get('/files', (req, res) => {
  const files = fs.existsSync(LOG_DIR)
    ? fs.readdirSync(LOG_DIR)
      .filter(name => /^system-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .map(name => {
        const stat = fs.statSync(path.join(LOG_DIR, name))
        return {
          date: name.replace(/^system-/, '').replace(/\.log$/, ''),
          name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
    : []

  res.json({ success: true, data: files })
})

router.get('/', (req, res) => {
  const { date, level, event, keyword } = req.query
  const limit = Math.min(Math.max(parseInt(req.query.limit || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const { date: safeDate, filePath } = resolveLogFile(date)
  const content = readTail(filePath)
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null

  let list = content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseLine)

  if (level) {
    const expected = String(level).toUpperCase()
    list = list.filter(item => String(item.level || '').toUpperCase() === expected)
  }

  if (event) {
    const text = String(event).toLowerCase()
    list = list.filter(item => String(item.event || '').toLowerCase().includes(text))
  }

  if (keyword) {
    const text = String(keyword).toLowerCase()
    list = list.filter(item => JSON.stringify(item).toLowerCase().includes(text))
  }

  list = list.reverse().slice(0, limit)

  res.json({
    success: true,
    data: {
      date: safeDate,
      exists: Boolean(stat),
      fileSize: stat?.size || 0,
      truncated: Boolean(stat && stat.size > MAX_READ_BYTES),
      maxReadBytes: MAX_READ_BYTES,
      limit,
      list
    }
  })
})

module.exports = router
