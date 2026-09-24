const jwt = require('jsonwebtoken')
const User = require('../models/User')
const { resolveJwtConfig } = require('../config/jwt')

const ALLOWED_ROLES = new Set(['agent', 'supervisor', 'admin'])

function normalizeRole(role) {
  return role === 'user' ? 'agent' : role
}

function toPlainUser(user) {
  if (!user) return null
  return typeof user.get === 'function' ? user.get({ plain: true }) : user
}

function bearerToken(req) {
  const match = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function createAuthenticate({
  environment = process.env,
  findUser = id => User.findByPk(id, {
    attributes: ['id', 'username', 'email', 'role', 'status']
  })
} = {}) {
  const config = resolveJwtConfig(environment)

  return async function authenticate(req, res, next) {
    const token = bearerToken(req)
    if (!token) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }

    try {
      const claims = jwt.verify(token, config.secret, {
        algorithms: config.algorithms,
        issuer: config.issuer,
        audience: config.audience
      })
      const storedUser = toPlainUser(await findUser(claims.id))
      if (!storedUser || storedUser.status !== 'active') {
        return res.status(401).json({ success: false, message: '账号不可用' })
      }

      const role = normalizeRole(storedUser.role)
      if (!ALLOWED_ROLES.has(role)) {
        return res.status(403).json({ success: false, message: '账号角色无权访问' })
      }

      req.user = {
        id: storedUser.id,
        userId: storedUser.id,
        username: storedUser.username,
        email: storedUser.email || null,
        role
      }
      return next()
    } catch {
      return res.status(401).json({ success: false, message: '认证失败' })
    }
  }
}

module.exports = { createAuthenticate, normalizeRole }
