const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')
const { normalizeProjectionJobQuery } = require('./commerceProjectionAdminRepository')

function requireProjectionAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next()
  return res.status(403).json({
    success: false,
    error: { code: 'FORBIDDEN', message: 'Only administrators can manage projection jobs' }
  })
}

function sendError(res, error, fallbackCode) {
  const status = Number.isSafeInteger(error?.status) ? error.status : 500
  return res.status(status).json({
    success: false,
    error: {
      code: status < 500 ? (error.code || fallbackCode) : 'INTERNAL_ERROR',
      message: status < 500 ? error.message : 'Projection operation failed'
    }
  })
}

function createCommerceProjectionAdminRouter({ repository, authenticate = createAuthenticate() }) {
  if (!repository || typeof repository.list !== 'function' || typeof repository.replay !== 'function') {
    throw new TypeError('Commerce projection admin router repository is invalid')
  }
  const router = express.Router()
  router.use(authenticate, requireProjectionAdmin)

  router.get('/', async (req, res) => {
    try {
      const data = await repository.list(normalizeProjectionJobQuery(req.query))
      return res.json({ success: true, data })
    } catch (error) {
      return sendError(res, error, 'INVALID_QUERY')
    }
  })

  router.post('/:id/replay', async (req, res) => {
    try {
      const data = await repository.replay(req.params.id, {
        actorId: req.user.id,
        reason: req.body?.reason
      })
      return res.json({ success: true, data })
    } catch (error) {
      return sendError(res, error, 'REPLAY_FAILED')
    }
  })

  return router
}

module.exports = { createCommerceProjectionAdminRouter, requireProjectionAdmin }

