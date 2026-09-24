'use strict'

const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')

const canRead = user => ['agent', 'supervisor', 'admin'].includes(user?.role)
const canManage = user => ['supervisor', 'admin'].includes(user?.role)

function createWarehouseRouter({ service, authenticate = createAuthenticate() }) {
  const router = express.Router()
  const gate = (predicate, status = 403) => (req, res, next) => predicate(req.user) ? next() : res.status(status).json({ success: false, message: 'insufficient warehouse permission' })
  const respond = (handler) => async (req, res) => {
    try { res.json({ success: true, data: await handler(req) }) } catch (error) {
      const status = error?.code === 'warehouse_not_found'
        ? 404
        : error?.code?.startsWith('warehouse_') || /required|invalid|insufficient|not found|state/i.test(error.message)
          ? 400
          : 500
      res.status(status).json({ success: false, message: status === 500 ? 'warehouse request failed' : error.message })
    }
  }
  router.use(authenticate, gate(canRead))
  router.get('/', respond(() => service.listWarehouses()))
  router.post('/', gate(canManage), respond(req => service.createWarehouse(req.body, req.user.id)))
  router.get('/:code/inventory', respond(req => service.listInventory(req.params.code)))
  router.post('/:code/inventory/adjust', gate(canManage), respond(req => service.adjustStock({ ...req.body, warehouseCode: req.params.code }, req.user.id)))
  router.get('/:code/inventory/:skuCode', respond(req => service.getInventory(req.params.code, req.params.skuCode)))
  router.get('/:code/reservations', respond(req => service.listReservations(req.params.code, req.query.status)))
  router.get('/:code/ledger', respond(req => service.listLedger(req.params.code, {
    skuCode: req.query.skuCode,
    operationType: req.query.operationType,
    page: req.query.page,
    pageSize: req.query.pageSize
  })))
  router.post('/:code/reservations', gate(canManage), respond(req => service.reserve({ ...req.body, warehouseCode: req.params.code }, req.user.id)))
  router.post('/reservations/:reservationKey/release', gate(canManage), respond(req => service.release(req.params.reservationKey, req.user.id)))
  router.post('/reservations/:reservationKey/fulfill', gate(canManage), respond(req => service.fulfill(req.params.reservationKey, req.user.id)))
  return router
}

module.exports = { createWarehouseRouter, canReadWarehouse: canRead, canManageWarehouse: canManage }
