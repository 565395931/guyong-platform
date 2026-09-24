const express = require('express')
const { createAuthenticate } = require('../../middleware/authenticate')

function requireRoles(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: '无权访问管理功能' })
    }
    return next()
  }
}

function createLegacyAdminRouter({ controller, authenticate = createAuthenticate() }) {
  const router = express.Router()
  router.use(authenticate, requireRoles(['admin', 'supervisor']))
  router.get('/stats', controller.getStats)
  router.get('/seat-skill-tags', controller.getSeatSkillTags)
  router.post('/seat-skill-tags', controller.createSeatSkillTag)
  router.delete('/seat-skill-tags/:id', controller.deleteSeatSkillTag)

  router.use('/users', requireRoles(['admin']))
  router.get('/users', controller.getUsers)
  router.post('/users/:id/update', controller.updateUser)
  router.delete('/users/:id', controller.deleteUser)
  return router
}

module.exports = { createLegacyAdminRouter }
