const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')
const {
  normalizeChannelEventQuery,
  presentChannelEventSummaryRow,
  presentChannelEventDetailRow
} = require('./channelEventInbox.repository')

function createJwtAuth(options = {}) {
  return createAuthenticate(options)
}

function resolveEventAccessScope(user = {}) {
  if (['admin', 'supervisor'].includes(user.role)) return { mode: 'all' }
  if (user.role !== 'agent') return null
  const seatId = Number(user.id)
  return Number.isSafeInteger(seatId) && seatId > 0 ? { mode: 'bound', seatId } : null
}

function requireEventReader(req, res, next) {
  const accessScope = resolveEventAccessScope(req.user)
  if (!accessScope) return res.status(403).json({ success: false, message: '无权读取渠道事件' })
  req.eventAccessScope = accessScope
  next()
}

function normalizeEventId(value) {
  const raw = String(value ?? '')
  if (!/^[1-9]\d*$/.test(raw)) {
    const error = new Error('事件 ID 无效')
    error.status = 400
    throw error
  }
  const eventId = Number(raw)
  if (!Number.isSafeInteger(eventId)) {
    const error = new Error('事件 ID 无效')
    error.status = 400
    throw error
  }
  return eventId
}

function createChannelEventsRouter({ repository, authenticate = createJwtAuth() }) {
  const router = express.Router()
  router.use(authenticate, requireEventReader)

  router.get('/accounts', async (req, res) => {
    try {
      const { channel } = normalizeChannelEventQuery({ channel: req.query.channel })
      res.json({
        success: true,
        data: await repository.listAccountOptions(channel, req.eventAccessScope)
      })
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        message: error.status === 400 ? error.message : '账号选项查询失败'
      })
    }
  })

  router.get('/projection-summary', async (req, res) => {
    try {
      const { channel } = normalizeChannelEventQuery({ channel: req.query.channel })
      res.json({
        success: true,
        data: await repository.projectionSummary(channel, req.eventAccessScope)
      })
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        message: error.status === 400 ? error.message : 'Projection summary query failed'
      })
    }
  })

  router.get('/:id', async (req, res) => {
    try {
      const eventId = normalizeEventId(req.params.id)
      const row = await repository.detail(eventId, req.eventAccessScope)
      if (!row) return res.status(404).json({ success: false, message: '事件不存在' })
      res.json({ success: true, data: presentChannelEventDetailRow(row) })
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        message: error.status === 400 ? error.message : '事件查询失败'
      })
    }
  })

  router.get('/', async (req, res) => {
    try {
      const filters = normalizeChannelEventQuery(req.query)
      const [rows, total] = await Promise.all([
        repository.list(filters, req.eventAccessScope),
        repository.count(filters, req.eventAccessScope)
      ])
      res.json({
        success: true,
        data: {
          items: rows.map(presentChannelEventSummaryRow),
          total,
          limit: filters.limit,
          offset: filters.offset
        }
      })
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        message: error.status === 400 ? error.message : '事件查询失败'
      })
    }
  })

  return router
}

module.exports = {
  createChannelEventsRouter,
  createJwtAuth,
  requireEventReader,
  resolveEventAccessScope
}
