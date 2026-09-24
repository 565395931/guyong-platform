const express = require('express')
const jwt = require('jsonwebtoken')
const { JWT_SECRET } = require('../../config/jwt')

function createJwtAuth() {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required' })
    try {
      const user = jwt.verify(token, JWT_SECRET || 'rag_secret_key_2024_dev_only')
      if (!['agent', 'supervisor', 'admin'].includes(user.role)) {
        return res.status(403).json({ success: false, message: 'Review access denied' })
      }
      req.user = user
      next()
    } catch (error) {
      return res.status(401).json({ success: false, message: `Authentication failed: ${error.message}` })
    }
  }
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function statusForError(error) {
  const statuses = {
    REVIEW_INVALID_MESSAGE: 400,
    REVIEW_INVALID_REPLY: 400,
    REVIEW_INVALID_REASON: 400,
    REVIEW_INVALID_SCOPE: 400,
    REVIEW_FORBIDDEN: 403,
    REVIEW_NOT_FOUND: 404,
    REVIEW_CONFLICT: 409,
    REVIEW_SEND_FAILED: 502
  }
  return statuses[error?.code] || 500
}

function createReviewRouter({ service, authenticate = createJwtAuth(), logger = console }) {
  if (!service) throw new TypeError('review service is required')
  const router = express.Router()
  router.use(authenticate)

  const handle = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const status = statusForError(error)
      logger.error?.('review_route_failed', {
        method: req.method,
        path: req.originalUrl,
        status,
        errorCode: error.code || 'REVIEW_INTERNAL_ERROR',
        errorName: error.name,
        errorMessage: error.message,
        actorIdPresent: Boolean(req.user?.id || req.user?.userId),
        actorRole: req.user?.role || null
      })
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Message review operation failed' : error.message,
        code: error.code || 'REVIEW_INTERNAL_ERROR'
      })
    }
  }

  router.get('/stats', handle(async (req, res) => {
    const data = await service.stats(req.user)
    res.json({ success: true, data })
  }))

  router.get('/', handle(async (req, res) => {
    const scope = req.query.scope || 'mine'
    if (scope === 'all' && !['supervisor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'All review scope requires supervisor access' })
    }
    if (!['mine', 'public', 'all'].includes(scope)) {
      return res.status(400).json({ success: false, message: 'Invalid review scope' })
    }
    const limit = positiveInteger(req.query.limit, 20, 100)
    const page = positiveInteger(req.query.page, 1)
    const data = await service.list({
      scope,
      operatorId: req.user.id || req.user.userId,
      role: req.user.role,
      status: req.query.status || null,
      riskLevel: req.query.risk_level || null,
      channel: req.query.channel || null,
      limit,
      offset: (page - 1) * limit
    })
    res.json({ success: true, data: { ...data, page, limit } })
  }))

  router.get('/:id', handle(async (req, res) => {
    const data = await service.detail(req.params.id, req.user)
    res.json({ success: true, data })
  }))

  router.post('/:id/claim', handle(async (req, res) => {
    const data = await service.claim(req.params.id, req.user)
    res.json({ success: true, data })
  }))

  router.post('/:id/takeover', handle(async (req, res) => {
    const data = await service.takeover(req.params.id, req.user)
    res.json({ success: true, data })
  }))

  router.post('/:id/release', handle(async (req, res) => {
    const data = await service.release(req.params.id, req.user)
    res.json({ success: true, data })
  }))

  router.post('/:id/reply', handle(async (req, res) => {
    const data = await service.reply(req.params.id, req.user, req.body?.text)
    res.json({ success: true, data })
  }))

  router.post('/:id/dismiss', handle(async (req, res) => {
    if (!req.body?.reasonCode) {
      return res.status(400).json({ success: false, message: 'No-reply reason is required' })
    }
    const data = await service.dismiss(req.params.id, req.user, {
      reasonCode: req.body.reasonCode,
      note: req.body.note
    })
    res.json({ success: true, data })
  }))

  return router
}

module.exports = {
  createJwtAuth,
  createReviewRouter,
  positiveInteger,
  statusForError
}
