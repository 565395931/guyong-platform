const express = require('express')
const { sequelize: defaultSequelize } = require('../config/database')
const { createAuthenticate } = require('../middleware/authenticate')
const { createCampaignRepository } = require('../modules/campaigns/campaign.repository')
const { createCampaignService } = require('../modules/campaigns/campaignService')
const { getCampaignBlueprints } = require('../modules/marketing/marketingLibrary')

function createErrorResponse(error) {
  const statusCode = error.statusCode || error.status || 500
  return {
    statusCode,
    body: {
      success: false,
      message: statusCode >= 500 ? '营销任务处理失败' : error.message
    }
  }
}

function createCampaignsRouter({
  sequelize = defaultSequelize,
  repository = createCampaignRepository(sequelize),
  service = createCampaignService({ repository }),
  authenticate = createAuthenticate()
} = {}) {
  const router = express.Router()
  router.use(authenticate)

  router.get('/tasks', async (req, res) => {
    try {
      const result = await repository.listTasks({
        user: req.user,
        filters: req.query
      })
      res.json({ success: true, data: result })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.get('/blueprints', async (req, res) => {
    try {
      const list = getCampaignBlueprints({
        channel: req.query.channel,
        type: req.query.type
      })
      res.json({ success: true, data: { list, total: list.length } })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.get('/tasks/:id', async (req, res) => {
    try {
      const task = await repository.getTask(String(req.params.id || '').trim(), req.user)
      if (!task) return res.status(404).json({ success: false, message: '任务不存在或无权访问' })
      res.json({ success: true, data: task })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.post('/tasks', async (req, res) => {
    try {
      const task = await service.create(req.body, req.user)
      res
        .status(201)
        .set('Location', `/api/v1/campaigns/tasks/${task.id}`)
        .json({ success: true, message: '任务已创建并进入执行队列', data: task })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.patch('/tasks/:id', async (req, res) => {
    try {
      const nextStatus = String(req.body?.status || req.body?.action || '').trim().toLowerCase()
      const task = await repository.updateTaskStatus(String(req.params.id || '').trim(), nextStatus, req.user)
      res.json({ success: true, message: '任务状态已更新', data: task })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  return router
}

module.exports = createCampaignsRouter()
module.exports.createCampaignsRouter = createCampaignsRouter
module.exports.createErrorResponse = createErrorResponse

