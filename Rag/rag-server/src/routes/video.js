const express = require('express')
const { sequelize: defaultSequelize } = require('../config/database')
const { createAuthenticate } = require('../middleware/authenticate')
const {
  getVideoTemplates,
  getVideoTemplate,
  normalizeVideoGenerationInput,
  buildVideoGenerationPlan,
  summarizeMediaFile,
  normalizeStrings
} = require('../modules/marketing/marketingLibrary')

function createErrorResponse(error) {
  const statusCode = error.statusCode || error.status || 500
  return {
    statusCode,
    body: {
      success: false,
      message: statusCode >= 500 ? '视频营销处理失败' : error.message
    }
  }
}

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_MEDIA_BASE_URL || process.env.SERVER_HOST || ''
  if (configured) return configured.replace(/\/$/, '')

  const host = req.get('host')
  if (host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
    return `${req.protocol}://host.docker.internal:${host.split(':')[1] || '3001'}`
  }

  return `${req.protocol}://${host}`
}

function toPublicMediaFile(row, req) {
  const baseUrl = getBaseUrl(req)
  return summarizeMediaFile({
    id: row.id,
    originalName: row.original_name,
    displayName: row.display_name || row.original_name,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    size: Number(row.size || 0),
    url: row.url,
    fullUrl: `${baseUrl}${row.url}`
  })
}

async function resolveMediaFiles(sequelize, mediaFileIds = [], req) {
  const ids = normalizeStrings(mediaFileIds)
  if (ids.length === 0 || !sequelize || typeof sequelize.query !== 'function') return []

  const [rows] = await sequelize.query(
    `SELECT id, original_name, display_name, description, filename, media_type, mime_type, size, url, uploader_id, created_at, updated_at
       FROM media_files
      WHERE id IN (:ids)`,
    { replacements: { ids } }
  )

  const rowMap = new Map(rows.map(row => [String(row.id), row]))
  return ids
    .map(id => rowMap.get(String(id)))
    .filter(Boolean)
    .map(row => toPublicMediaFile(row, req))
}

function createVideoRouter({
  sequelize = defaultSequelize,
  authenticate = createAuthenticate()
} = {}) {
  const router = express.Router()
  router.use(authenticate)

  router.get('/templates', async (req, res) => {
    try {
      const list = getVideoTemplates({ channel: req.query.channel })
      res.json({ success: true, data: { list, total: list.length } })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.post('/generate', async (req, res) => {
    try {
      const parsed = normalizeVideoGenerationInput(req.body)
      if (parsed.error) {
        return res.status(400).json({ success: false, message: parsed.error })
      }

      const template = getVideoTemplate(parsed.data.templateId)
      if (!template) {
        return res.status(404).json({ success: false, message: '视频模板不存在' })
      }

      const mediaFiles = await resolveMediaFiles(sequelize, parsed.data.mediaFileIds, req)
      const plan = buildVideoGenerationPlan({
        template,
        input: parsed.data,
        mediaFiles,
        now: () => new Date()
      })

      res.json({
        success: true,
        message: '视频营销方案已生成',
        data: plan
      })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  return router
}

module.exports = createVideoRouter()
module.exports.createVideoRouter = createVideoRouter
module.exports.createErrorResponse = createErrorResponse

