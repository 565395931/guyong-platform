'use strict'

const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')

const canManage = user => ['supervisor', 'admin'].includes(user?.role)

function createOrderFulfillmentRouter({ service, authenticate = createAuthenticate() }) {
  if (!service) throw new TypeError('order fulfillment service is required')
  const router = express.Router()
  router.use(authenticate)
  router.use((req, res, next) => canManage(req.user)
    ? next()
    : res.status(403).json({ success: false, message: 'insufficient permissions' }))
  const respond = handler => async (req, res) => {
    try {
      res.json({ success: true, data: await handler(req) })
    } catch (error) {
      const status = ['fulfillment_invalid_input'].includes(error.code) ? 400
        : ['fulfillment_order_not_found', 'fulfillment_sku_missing', 'fulfillment_items_missing'].includes(error.code) ? 404
          : ['fulfillment_not_reserved', 'fulfillment_state_invalid'].includes(error.code) ? 409 : 500
      res.status(status).json({ success: false, message: status === 500 ? 'fulfillment operation failed' : error.message })
    }
  }
  router.post('/orders/:orderId/reserve', respond(req => service.reserve({ ...req.body, orderId: req.params.orderId, operatorId: req.user.id })))
  router.post('/orders/:orderId/ship', respond(req => service.ship({ ...req.body, orderId: req.params.orderId, operatorId: req.user.id })))
  return router
}

module.exports = { createOrderFulfillmentRouter, canManage }
