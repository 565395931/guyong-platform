const express = require('express')
const jwt = require('jsonwebtoken')
const statisticsService = require('../modules/statistics/statistics.service')

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'

router.use((req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证令牌' })
  }
  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
    if (!['agent', 'supervisor', 'admin'].includes(decoded.role)) {
      return res.status(403).json({ success: false, message: '无权访问统计数据' })
    }
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

function scopedQuery(req) {
  const query = { ...req.query }
  if (req.user.role === 'agent') {
    query.visibility_user_id = req.user.id
  }
  return query
}

function scopedAgentQuery(req) {
  const query = scopedQuery(req)
  if (req.user.role === 'agent') {
    query.agent_id = req.user.id
  }
  return query
}

router.get('/overview', async (req, res) => {
  try {
    const data = await statisticsService.getOverview(scopedQuery(req))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[Statistics] overview failed:', err.message)
    res.status(500).json({ success: false, message: '统计总览查询失败: ' + err.message })
  }
})

router.get('/agent-performance', async (req, res) => {
  try {
    const data = await statisticsService.getAgentPerformance(scopedAgentQuery(req))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[Statistics] agent-performance failed:', err.message)
    res.status(500).json({ success: false, message: '客服绩效查询失败: ' + err.message })
  }
})

router.get('/after-sales', async (req, res) => {
  try {
    const data = await statisticsService.getAfterSalesStats(scopedQuery(req))
    res.json({ success: true, data })
  } catch (err) {
    console.error('[Statistics] after-sales failed:', err.message)
    res.status(500).json({ success: false, message: '售后统计查询失败: ' + err.message })
  }
})

router.post('/export', async (req, res) => {
  try {
    const query = scopedAgentQuery({ query: req.body || {}, user: req.user })
    const data = await statisticsService.getAgentPerformance(query)
    const csv = statisticsService.toCsv(data.list)
    const filename = `statistics-${data.range.startDate}-${data.range.endDate}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (err) {
    console.error('[Statistics] export failed:', err.message)
    res.status(500).json({ success: false, message: '导出统计报表失败: ' + err.message })
  }
})

module.exports = router
