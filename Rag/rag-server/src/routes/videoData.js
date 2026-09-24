const express = require('express')
const { sequelize: defaultSequelize } = require('../config/database')
const { createAuthenticate } = require('../middleware/authenticate')
const {
  normalizeText,
  parseDate,
  normalizeVideoDataInput,
  presentVideoDataRecord,
  buildVideoDataCsv
} = require('../modules/video-data/videoData.service')

function createErrorResponse(error) {
  const statusCode = error.statusCode || error.status || 500
  return {
    statusCode,
    body: {
      success: false,
      message: statusCode >= 500 ? '视频数据处理失败' : error.message
    }
  }
}

function createHttpError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function requireManager(req, res, next) {
  if (!['admin', 'supervisor'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: '无权访问视频数据管理' })
  }
  return next()
}

function normalizeQueryDate(value, fieldName) {
  const clean = normalizeText(value)
  if (!clean) return null
  const parsed = parseDate(clean)
  if (!parsed) throw createHttpError(`${fieldName}格式不正确`, 400)
  return parsed
}

function normalizePagination(query = {}) {
  const page = Math.max(Number(query.page || 1), 1)
  const pageSize = Math.min(Math.max(Number(query.pageSize || 20), 1), 100)
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize }
}

function buildWhereClause(query = {}) {
  const conditions = []
  const replacements = {}

  const startDate = normalizeQueryDate(query.startDate, '开始日期')
  const endDate = normalizeQueryDate(query.endDate, '结束日期')
  const keyword = normalizeText(query.keyword)
  const platform = normalizeText(query.platform).toLowerCase()

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError('开始日期不能晚于结束日期', 400)
  }

  if (startDate) {
    conditions.push('data_date >= :startDate')
    replacements.startDate = startDate
  }
  if (endDate) {
    conditions.push('data_date <= :endDate')
    replacements.endDate = endDate
  }
  if (platform) {
    conditions.push('platform = :platform')
    replacements.platform = platform
  }
  if (keyword) {
    conditions.push('(account_no LIKE :keyword OR platform LIKE :keyword OR remark LIKE :keyword)')
    replacements.keyword = `%${keyword}%`
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    replacements
  }
}

function rowSummary(row = {}) {
  return {
    totalRecords: Number(row.totalRecords || row.total_records || row.total || 0),
    playCount: Number(row.playCount || row.play_count || 0),
    likeCount: Number(row.likeCount || row.like_count || 0),
    commentCount: Number(row.commentCount || row.comment_count || 0),
    inquiryCount: Number(row.inquiryCount || row.inquiry_count || 0),
    intentCustomerCount: Number(row.intentCustomerCount || row.intent_customer_count || 0),
    dealCount: Number(row.dealCount || row.deal_count || 0)
  }
}

async function fetchVideoDataSummary(sequelize, query = {}) {
  const { whereSql, replacements } = buildWhereClause(query)
  const [rows] = await sequelize.query(
    `SELECT
       COUNT(*) AS totalRecords,
       COALESCE(SUM(play_count), 0) AS playCount,
       COALESCE(SUM(like_count), 0) AS likeCount,
       COALESCE(SUM(comment_count), 0) AS commentCount,
       COALESCE(SUM(inquiry_count), 0) AS inquiryCount,
       COALESCE(SUM(intent_customer_count), 0) AS intentCustomerCount,
       COALESCE(SUM(deal_count), 0) AS dealCount
     FROM video_account_data
     ${whereSql}`,
    { replacements }
  )
  return rowSummary(rows[0] || {})
}

async function fetchVideoDataList(sequelize, query = {}) {
  const { page, pageSize, limit, offset } = normalizePagination(query)
  const { whereSql, replacements } = buildWhereClause(query)
  const pagingReplacements = { ...replacements, limit, offset }

  const [rows] = await sequelize.query(
    `SELECT id, data_date, account_no, platform, play_count, like_count, comment_count,
            inquiry_count, intent_customer_count, deal_count, remark, created_by, created_at, updated_at
       FROM video_account_data
       ${whereSql}
       ORDER BY data_date DESC, id DESC
       LIMIT :limit OFFSET :offset`,
    { replacements: pagingReplacements }
  )
  const [countRows] = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM video_account_data
       ${whereSql}`,
    { replacements }
  )

  return {
    list: rows.map(presentVideoDataRecord),
    total: Number(countRows[0]?.total || 0),
    page,
    pageSize
  }
}

function buildMutationPayload(body = {}, user = {}) {
  const parsed = normalizeVideoDataInput(body)
  if (parsed.error) {
    const error = createHttpError(parsed.error, 400)
    throw error
  }

  return {
    ...parsed.data,
    createdBy: user.id || user.userId || null
  }
}

function createVideoDataRouter({
  sequelize = defaultSequelize,
  authenticate = createAuthenticate()
} = {}) {
  const router = express.Router()
  router.use(authenticate)
  router.use(requireManager)

  router.get('/', async (req, res) => {
    try {
      const [list, summary] = await Promise.all([
        fetchVideoDataList(sequelize, req.query),
        fetchVideoDataSummary(sequelize, req.query)
      ])
      res.json({ success: true, data: { ...list, summary } })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.get('/summary', async (req, res) => {
    try {
      const summary = await fetchVideoDataSummary(sequelize, req.query)
      res.json({ success: true, data: summary })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.get('/export', async (req, res) => {
    try {
      const { whereSql, replacements } = buildWhereClause(req.query)
      const [rows] = await sequelize.query(
        `SELECT id, data_date, account_no, platform, play_count, like_count, comment_count,
                inquiry_count, intent_customer_count, deal_count, remark
           FROM video_account_data
           ${whereSql}
           ORDER BY data_date DESC, id DESC`,
        { replacements }
      )

      const csv = buildVideoDataCsv(rows.map(presentVideoDataRecord))
      const startDate = normalizeText(req.query.startDate) || 'all'
      const endDate = normalizeText(req.query.endDate) || 'all'
      const filename = `video-data-${startDate}-${endDate}.csv`

      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(csv)
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.post('/', async (req, res) => {
    try {
      const payload = buildMutationPayload(req.body, req.user)
      await sequelize.query(
        `INSERT INTO video_account_data
           (data_date, account_no, platform, play_count, like_count, comment_count,
            inquiry_count, intent_customer_count, deal_count, remark, created_by, created_at, updated_at)
         VALUES
           (:dataDate, :accountNo, :platform, :playCount, :likeCount, :commentCount,
            :inquiryCount, :intentCustomerCount, :dealCount, :remark, :createdBy, NOW(), NOW())`,
        {
          replacements: {
            dataDate: payload.dataDate,
            accountNo: payload.accountNo,
            platform: payload.platform,
            playCount: payload.playCount,
            likeCount: payload.likeCount,
            commentCount: payload.commentCount,
            inquiryCount: payload.inquiryCount,
            intentCustomerCount: payload.intentCustomerCount,
            dealCount: payload.dealCount,
            remark: payload.remark || null,
            createdBy: payload.createdBy
          }
        }
      )

      const [rows] = await sequelize.query(
        `SELECT id, data_date, account_no, platform, play_count, like_count, comment_count,
                inquiry_count, intent_customer_count, deal_count, remark, created_by, created_at, updated_at
           FROM video_account_data
          WHERE data_date = :dataDate AND account_no = :accountNo AND platform = :platform
          ORDER BY id DESC
          LIMIT 1`,
        {
          replacements: {
            dataDate: payload.dataDate,
            accountNo: payload.accountNo,
            platform: payload.platform
          }
        }
      )

      res.status(201).json({
        success: true,
        message: '视频数据已创建',
        data: presentVideoDataRecord(rows[0] || {
          id: null,
          data_date: payload.dataDate,
          account_no: payload.accountNo,
          platform: payload.platform,
          play_count: payload.playCount,
          like_count: payload.likeCount,
          comment_count: payload.commentCount,
          inquiry_count: payload.inquiryCount,
          intent_customer_count: payload.intentCustomerCount,
          deal_count: payload.dealCount,
          remark: payload.remark,
          created_by: payload.createdBy
        })
      })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.put('/:id', async (req, res) => {
    try {
      const payload = buildMutationPayload(req.body, req.user)
      const [existingRows] = await sequelize.query(
        `SELECT id FROM video_account_data WHERE id = :id LIMIT 1`,
        { replacements: { id: req.params.id } }
      )
      if (!existingRows[0]) {
        return res.status(404).json({ success: false, message: '视频数据不存在' })
      }

      await sequelize.query(
        `UPDATE video_account_data
            SET data_date = :dataDate,
                account_no = :accountNo,
                platform = :platform,
                play_count = :playCount,
                like_count = :likeCount,
                comment_count = :commentCount,
                inquiry_count = :inquiryCount,
                intent_customer_count = :intentCustomerCount,
                deal_count = :dealCount,
                remark = :remark,
                updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: {
            id: req.params.id,
            dataDate: payload.dataDate,
            accountNo: payload.accountNo,
            platform: payload.platform,
            playCount: payload.playCount,
            likeCount: payload.likeCount,
            commentCount: payload.commentCount,
            inquiryCount: payload.inquiryCount,
            intentCustomerCount: payload.intentCustomerCount,
            dealCount: payload.dealCount,
            remark: payload.remark || null
          }
        }
      )

      const [rows] = await sequelize.query(
        `SELECT id, data_date, account_no, platform, play_count, like_count, comment_count,
                inquiry_count, intent_customer_count, deal_count, remark, created_by, created_at, updated_at
           FROM video_account_data
          WHERE id = :id
          LIMIT 1`,
        { replacements: { id: req.params.id } }
      )

      res.json({ success: true, message: '视频数据已更新', data: presentVideoDataRecord(rows[0]) })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      const [existingRows] = await sequelize.query(
        `SELECT id FROM video_account_data WHERE id = :id LIMIT 1`,
        { replacements: { id: req.params.id } }
      )
      if (!existingRows[0]) {
        return res.status(404).json({ success: false, message: '视频数据不存在' })
      }

      await sequelize.query(
        `DELETE FROM video_account_data WHERE id = :id`,
        { replacements: { id: req.params.id } }
      )

      res.json({ success: true, message: '视频数据已删除' })
    } catch (error) {
      const response = createErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  })

  return router
}

module.exports = createVideoDataRouter()
module.exports.createVideoDataRouter = createVideoDataRouter
module.exports.createErrorResponse = createErrorResponse
module.exports.buildWhereClause = buildWhereClause
module.exports.fetchVideoDataList = fetchVideoDataList
module.exports.fetchVideoDataSummary = fetchVideoDataSummary

