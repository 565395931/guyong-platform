const express = require('express')
const jwt = require('jsonwebtoken')
const { JWT_SECRET } = require('../../config/jwt')

function createJwtAuth(secret = JWT_SECRET) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ success: false, message: '未提供认证令牌' })
    try {
      req.user = jwt.verify(token, secret)
      next()
    } catch {
      res.status(401).json({ success: false, message: '认证失败' })
    }
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next()
  res.status(403).json({ success: false, message: '仅管理员可管理系统账号' })
}

function respond(handler) {
  return async (req, res) => {
    try {
      res.json({ success: true, data: await handler(req) })
    } catch (error) {
      res.status(error.status || 500).json({ success: false, message: error.message || '请求失败' })
    }
  }
}

function createSystemAccountsRouter({ service, authenticate, jwtSecret, accountMode = 'team' } = {}) {
  if (!service) throw new Error('system accounts service is required')
  const router = express.Router()
  router.use(authenticate || createJwtAuth(jwtSecret), requireAdmin)
  router.use((req, res, next) => {
    if (accountMode === 'team') return next()
    res.status(403).json({ success: false, message: '当前为单账号模式，系统账号管理未启用' })
  })
  router.get('/', respond(async req => {
    const users = await service.list(req.query)
    if (!req.app.get('seatAssignment')) return users
    const live = require('../websocket/socketHandler').connectedSeatIds()
    const { effectiveSeatStatus } = require('../conversation-pool/seatAssignment.service')
    return users.map(user => ({ ...user, currentLoad: Number(user.currentLoad || 0),
      seatStatus: user.role === 'agent'
        ? effectiveSeatStatus(live.includes(Number(user.id)) ? user.availability || 'offline' : 'offline', user.currentLoad)
        : null }))
  }))
  router.post('/', respond(req => service.create(req.body)))
  router.patch('/:id', respond(req => service.update(req.params.id, req.body, { actorId: req.user.id })))
  router.post('/:id/reset-password', respond(req => service.resetPassword(req.params.id, req.body)))
  router.delete('/:id', respond(req => service.remove(req.params.id, { actorId: req.user.id })))
  return router
}

module.exports = { createJwtAuth, requireAdmin, createSystemAccountsRouter }
