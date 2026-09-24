/**
 * 快捷指令管理 API
 *
 * 后台用于配置客服快捷回复指令，聚合工作台可通过输入 / 搜索并选择后填入回复框。
 */

const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { sequelize } = require('../config/database')

const JWT_SECRET = process.env.JWT_SECRET
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'

function normalizeShortcut(shortcut = '') {
  const clean = String(shortcut || '').trim()
  if (!clean) return ''
  return clean.startsWith('/') ? clean : `/${clean}`
}

function toPublicQuickReply(row) {
  return {
    id: row.id,
    title: row.title,
    shortcut: row.shortcut,
    content: row.content,
    category: row.category || '',
    isEnabled: Boolean(row.is_enabled),
    sortOrder: Number(row.sort_order || 0),
    usageCount: Number(row.usage_count || 0),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function requireManager(req, res) {
  if (!['admin', 'supervisor'].includes(req.user?.role)) {
    res.status(403).json({ success: false, message: '仅管理员或主管可管理快捷指令' })
    return false
  }
  return true
}

function validatePayload(body = {}) {
  const title = String(body.title || '').trim()
  const shortcut = normalizeShortcut(body.shortcut)
  const content = String(body.content || '').trim()
  const category = String(body.category || '').trim()
  const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0
  const isEnabled = body.isEnabled === undefined ? true : Boolean(body.isEnabled)

  if (!title) return { error: '指令标题不能为空' }
  if (title.length > 100) return { error: '指令标题不能超过100个字符' }
  if (!shortcut) return { error: '触发词不能为空' }
  if (shortcut.length > 80) return { error: '触发词不能超过80个字符' }
  if (/\s/.test(shortcut)) return { error: '触发词不能包含空格' }
  if (!content) return { error: '回复内容不能为空' }
  if (content.length > 10000) return { error: '回复内容不能超过10000个字符' }
  if (category.length > 50) return { error: '分类不能超过50个字符' }

  return { data: { title, shortcut, content, category, sortOrder, isEnabled } }
}

// ========== 认证中间件 ==========
router.use((req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    return res.status(401).json({ success: false, message: '未提供认证令牌' })
  }
  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET)
    req.user = decoded
    if (!['admin', 'supervisor', 'agent'].includes(decoded.role)) {
      return res.status(403).json({ success: false, message: '无权限访问快捷指令' })
    }
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

// ========== 快捷指令列表 ==========
router.get('/', async (req, res) => {
  try {
    const { keyword = '', category = '', enabledOnly = '', page = 1, pageSize = 20 } = req.query
    const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100)
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit
    const replacements = { limit, offset }
    const where = []

    if (keyword) {
      where.push('(title LIKE :keyword OR shortcut LIKE :keyword OR content LIKE :keyword OR category LIKE :keyword)')
      replacements.keyword = `%${keyword}%`
    }
    if (category) {
      where.push('category = :category')
      replacements.category = String(category).trim()
    }
    if (enabledOnly === 'true' || enabledOnly === '1') {
      where.push('is_enabled = 1')
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [rows] = await sequelize.query(
      `SELECT id, title, shortcut, content, category, is_enabled, sort_order, usage_count, created_by, updated_by, created_at, updated_at
       FROM quick_replies
       ${whereSql}
       ORDER BY sort_order ASC, usage_count DESC, updated_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM quick_replies ${whereSql}`,
      { replacements }
    )

    res.json({
      success: true,
      data: {
        list: rows.map(toPublicQuickReply),
        total: Number(countRows[0]?.total || 0)
      }
    })
  } catch (err) {
    console.error('[QuickReplies] 查询列表失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

// ========== 新建快捷指令 ==========
router.post('/', async (req, res) => {
  try {
    if (!requireManager(req, res)) return
    const parsed = validatePayload(req.body)
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error })

    const id = crypto.randomUUID()
    const userId = req.user.id || req.user.userId || null
    await sequelize.query(
      `INSERT INTO quick_replies
        (id, title, shortcut, content, category, is_enabled, sort_order, usage_count, created_by, updated_by, created_at, updated_at)
       VALUES
        (:id, :title, :shortcut, :content, :category, :isEnabled, :sortOrder, 0, :userId, :userId, NOW(), NOW())`,
      { replacements: { id, ...parsed.data, userId } }
    )

    const [rows] = await sequelize.query(
      `SELECT id, title, shortcut, content, category, is_enabled, sort_order, usage_count, created_by, updated_by, created_at, updated_at
       FROM quick_replies WHERE id = :id LIMIT 1`,
      { replacements: { id } }
    )

    res.json({ success: true, data: toPublicQuickReply(rows[0]), message: '创建成功' })
  } catch (err) {
    console.error('[QuickReplies] 创建失败:', err.message)
    if (err.message?.includes('Duplicate')) {
      return res.status(409).json({ success: false, message: '触发词已存在，请更换后重试' })
    }
    res.status(500).json({ success: false, message: '创建失败: ' + err.message })
  }
})

// ========== 更新快捷指令 ==========
router.put('/:id', async (req, res) => {
  try {
    if (!requireManager(req, res)) return
    const parsed = validatePayload(req.body)
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error })

    const [existing] = await sequelize.query(
      `SELECT id FROM quick_replies WHERE id = :id`,
      { replacements: { id: req.params.id } }
    )
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: '快捷指令不存在' })
    }

    const userId = req.user.id || req.user.userId || null
    await sequelize.query(
      `UPDATE quick_replies
       SET title = :title,
           shortcut = :shortcut,
           content = :content,
           category = :category,
           is_enabled = :isEnabled,
           sort_order = :sortOrder,
           updated_by = :userId,
           updated_at = NOW()
       WHERE id = :id`,
      { replacements: { id: req.params.id, ...parsed.data, userId } }
    )

    const [rows] = await sequelize.query(
      `SELECT id, title, shortcut, content, category, is_enabled, sort_order, usage_count, created_by, updated_by, created_at, updated_at
       FROM quick_replies WHERE id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    )

    res.json({ success: true, data: toPublicQuickReply(rows[0]), message: '保存成功' })
  } catch (err) {
    console.error('[QuickReplies] 更新失败:', err.message)
    if (err.message?.includes('Duplicate')) {
      return res.status(409).json({ success: false, message: '触发词已存在，请更换后重试' })
    }
    res.status(500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

// ========== 启用/停用 ==========
router.patch('/:id/status', async (req, res) => {
  try {
    if (!requireManager(req, res)) return
    const isEnabled = Boolean(req.body?.isEnabled)
    const [result] = await sequelize.query(
      `UPDATE quick_replies SET is_enabled = :isEnabled, updated_at = NOW(), updated_by = :userId WHERE id = :id`,
      { replacements: { id: req.params.id, isEnabled, userId: req.user.id || req.user.userId || null } }
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '快捷指令不存在' })
    }
    res.json({ success: true, message: isEnabled ? '已启用' : '已停用' })
  } catch (err) {
    console.error('[QuickReplies] 状态更新失败:', err.message)
    res.status(500).json({ success: false, message: '状态更新失败: ' + err.message })
  }
})

// ========== 记录使用次数 ==========
router.post('/:id/use', async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE quick_replies SET usage_count = usage_count + 1, updated_at = NOW() WHERE id = :id`,
      { replacements: { id: req.params.id } }
    )
    res.json({ success: true, message: '已记录使用' })
  } catch (err) {
    console.error('[QuickReplies] 记录使用失败:', err.message)
    res.status(500).json({ success: false, message: '记录使用失败: ' + err.message })
  }
})

// ========== 删除快捷指令 ==========
router.delete('/:id', async (req, res) => {
  try {
    if (!requireManager(req, res)) return
    const [result] = await sequelize.query(
      `DELETE FROM quick_replies WHERE id = :id`,
      { replacements: { id: req.params.id } }
    )
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '快捷指令不存在' })
    }
    res.json({ success: true, message: '删除成功' })
  } catch (err) {
    console.error('[QuickReplies] 删除失败:', err.message)
    res.status(500).json({ success: false, message: '删除失败: ' + err.message })
  }
})

module.exports = router
