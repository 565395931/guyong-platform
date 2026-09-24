const express = require('express')
const jwt = require('jsonwebtoken')
const multer = require('multer')
const path = require('path')

const canReadCatalog = user => ['agent', 'supervisor', 'admin'].includes(user?.role)
const canManageCatalog = user => ['supervisor', 'admin'].includes(user?.role)

function statusForError(error) {
  const message = String(error?.message || '')
  if (/not found|不存在/i.test(message)) return 404
  if (/draft version|not ready|already|duplicate/i.test(message)) return 409
  if (/required|invalid|must be|不支持|文件类型/i.test(message)) return 400
  return 500
}

function createJwtAuth() {
  return (req, res, next) => {
    const secret = process.env.JWT_SECRET
    if (!secret) {
      return res.status(500).json({ success: false, message: 'JWT_SECRET 未配置' })
    }
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' })
    }
    try {
      req.user = jwt.verify(token, secret)
      next()
    } catch {
      res.status(401).json({ success: false, message: '认证失败' })
    }
  }
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
      const status = statusForError(error)
      res.status(status).json({
        success: false,
        message: status === 500 ? '目录操作失败，请稍后重试' : error.message || '请求失败'
      })
    }
  }
}

function createCatalogRouter({ catalogService, importService, quoteService, authenticate = createJwtAuth() }) {
  const router = express.Router()
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase()
      callback(extension === '.md' || extension === '.xlsx' || extension === '.xls'
        ? null
        : new Error('不支持的文件类型'), extension === '.md' || extension === '.xlsx' || extension === '.xls')
    }
  })

  router.use(authenticate, requirePermission(canReadCatalog))

  router.get('/versions', respond(() => catalogService.listVersions()))
  router.post('/versions/draft', requirePermission(canManageCatalog), respond(req => catalogService.createDraft(req.user.id)))
  router.post('/versions/:id/publish', requirePermission(canManageCatalog), respond(req => catalogService.publishVersion(req.params.id, req.user.id)))

  router.get('/versions/:id/products', respond(req => catalogService.listProducts(req.params.id)))
  router.post('/versions/:id/products', requirePermission(canManageCatalog), respond(req => catalogService.upsertProduct(req.params.id, req.body, req.user.id)))
  router.put('/versions/:id/products/:productCode', requirePermission(canManageCatalog), respond(req => catalogService.upsertProduct(req.params.id, { ...req.body, productCode: req.params.productCode }, req.user.id)))

  router.get('/versions/:id/skus', respond(req => catalogService.listSkus(req.params.id)))
  router.post('/versions/:id/skus', requirePermission(canManageCatalog), respond(req => catalogService.upsertSku(req.params.id, req.body, req.user.id)))
  router.put('/versions/:id/skus/:skuCode', requirePermission(canManageCatalog), respond(req => catalogService.upsertSku(req.params.id, { ...req.body, skuCode: req.params.skuCode }, req.user.id)))

  router.get('/versions/:id/prices', respond(req => catalogService.listPriceRules(req.params.id)))
  router.post('/versions/:id/prices', requirePermission(canManageCatalog), respond(req => catalogService.upsertPriceRule(req.params.id, req.body, req.user.id)))
  router.put('/versions/:id/prices/:ruleId', requirePermission(canManageCatalog), respond(req => catalogService.upsertPriceRule(req.params.id, { ...req.body, id: req.params.ruleId }, req.user.id)))

  router.get('/versions/:id/freight', respond(req => catalogService.listFreightRules(req.params.id)))
  router.post('/versions/:id/freight', requirePermission(canManageCatalog), respond(req => catalogService.upsertFreightRule(req.params.id, req.body, req.user.id)))
  router.put('/versions/:id/freight/:ruleId', requirePermission(canManageCatalog), respond(req => catalogService.upsertFreightRule(req.params.id, { ...req.body, id: req.params.ruleId }, req.user.id)))

  router.post('/import/preview', requirePermission(canManageCatalog), upload.single('file'), respond(req => importService.preview(req.file, req.user.id)))
  router.post('/import/:jobId/commit', requirePermission(canManageCatalog), respond(req => importService.commit(req.params.jobId, req.user.id)))
  router.post('/quote/resolve', respond(req => quoteService.resolveAndRecord(req.body, req.user.id)))

  router.use((error, req, res, next) => {
    if (!error) return next()
    const status = statusForError(error)
    res.status(status).json({ success: false, message: status === 500 ? '目录操作失败，请稍后重试' : error.message })
  })
  return router
}

module.exports = {
  createCatalogRouter,
  createJwtAuth,
  canReadCatalog,
  canManageCatalog,
  statusForError
}
