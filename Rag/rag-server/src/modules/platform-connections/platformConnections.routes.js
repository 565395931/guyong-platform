const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')

const canViewConnections = user => ['admin', 'supervisor'].includes(user?.role)
const canManageConnections = user => user?.role === 'admin'
const canManageAccountPolicy = user => ['admin', 'supervisor'].includes(user?.role)
const canManageAllowlist = user => ['admin', 'supervisor'].includes(user?.role)

function statusForError(error) {
  const message = String(error?.message || '')
  if (/not found/i.test(message)) return 404
  if (/already exists|duplicate/i.test(message)) return 409
  if (/disable runtime before editing/i.test(message)) return 409
  if (/runtime config publisher is not configured|cloud gateway is not connected|confirmation timed out/i.test(message)) return 503
  if (/required|invalid|cannot|requires|not available|available only|only an active|too long|must be|locked/i.test(message)) return 400
  return 500
}

function createJwtAuth(options = {}) {
  return createAuthenticate(options)
}

function requirePermission(predicate) {
  return (req, res, next) => {
    if (predicate(req.user)) return next()
    res.status(403).json({ success: false, message: '无权执行此操作' })
  }
}

function respond(handler) {
  return async (req, res) => {
    try {
      res.json({ success: true, data: await handler(req) })
    } catch (error) {
      res.status(statusForError(error)).json({
        success: false,
        message: error.message || '请求失败'
      })
    }
  }
}

function createPlatformConnectionsRouter({ service, authenticate = createJwtAuth() }) {
  const router = express.Router()
  router.use(authenticate, requirePermission(canViewConnections))

  router.get('/', respond(() => service.listConnections()))
  router.post('/', requirePermission(canManageConnections), respond(req => service.createConnection(req.body, req.user.id)))
  router.patch('/:id/credentials', requirePermission(canManageConnections), respond(req => service.replaceCredentials(req.params.id, req.body, req.user.id)))
  router.post('/:id/verify', requirePermission(canManageConnections), respond(req => service.verifyConnection(req.params.id, req.user.id)))
  router.post('/:id/publish-runtime', requirePermission(canManageConnections), respond(req => service.publishRuntimeConfig(req.params.id, req.user.id)))
  router.post('/:id/disable-runtime', requirePermission(canManageConnections), respond(req => service.disableRuntimeConfig(req.params.id, req.user.id)))
  router.get('/:id/accounts', respond(req => service.listAccounts(req.params.id)))
  router.patch('/accounts/:accountId/policy', requirePermission(canManageAccountPolicy), respond(req => service.updateAccountPolicy(req.params.accountId, req.body, req.user.id)))
  router.get('/accounts/:accountId/allowlist', respond(req => service.listAllowlist(req.params.accountId)))
  router.post('/accounts/:accountId/allowlist', requirePermission(canManageAllowlist), respond(req => service.addAllowlistEntry(req.params.accountId, req.body, req.user.id)))
  router.delete('/accounts/:accountId/allowlist/:entryId', requirePermission(canManageAllowlist), respond(req => service.removeAllowlistEntry(req.params.accountId, req.params.entryId, req.user.id)))
  router.get('/operation-logs', respond(req => service.listOperationLogs(req.query)))

  return router
}

module.exports = {
  canViewConnections,
  canManageConnections,
  canManageAccountPolicy,
  canManageAllowlist,
  createPlatformConnectionsRouter,
  createJwtAuth,
  statusForError
}
