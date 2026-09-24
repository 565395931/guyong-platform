'use strict'

const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')

const canRead = user => ['agent', 'supervisor', 'admin'].includes(user?.role)
const canManage = user => ['supervisor', 'admin'].includes(user?.role)

function requireRole(predicate) {
  return (req, res, next) => predicate(req.user)
    ? next()
    : res.status(403).json({ success: false, message: 'insufficient permissions' })
}

function respond(handler) {
  return async (req, res) => {
    try {
      res.json({ success: true, data: await handler(req) })
    } catch (error) {
      const status = error.code === 'platform_sku_mapping_invalid' ? 400 : error.code === 'platform_sku_mapping_unavailable' ? 404 : 500
      res.status(status).json({ success: false, message: status === 500 ? 'platform SKU mapping operation failed' : error.message })
    }
  }
}

function createPlatformSkuMappingRouter({ service, authenticate = createAuthenticate() }) {
  if (!service) throw new TypeError('platform SKU mapping service is required')
  const router = express.Router()
  router.use(authenticate, requireRole(canRead))
  router.get('/', respond(req => service.list(req.query)))
  router.post('/', requireRole(canManage), respond(req => service.upsert({ ...req.body, operatorId: req.user.id })))
  router.patch('/:id/status', requireRole(canManage), respond(req => service.setStatus(req.params.id, req.body?.status, req.user.id)))
  return router
}

module.exports = { createPlatformSkuMappingRouter, canRead, canManage }
