const express = require('express')
const { sequelize } = require('../config/database')
const { createAuthenticate } = require('../middleware/authenticate')
const { createQuickReplyPersonalizationService } = require('../modules/system-accounts/quickReplyPersonalization.service')
const router = express.Router()
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

function validatePayload(body = {}) {
  const title = String(body.title || '').trim()
  const shortcut = normalizeShortcut(body.shortcut)
  const content = String(body.content || '').trim()
  const category = String(body.category || '').trim()
  const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0
  const isEnabled = body.isEnabled === undefined ? true : Boolean(body.isEnabled)
  // 归属：工作台的快捷话术面板按"创建人是不是我"分成「个人话术 / 公共话术」两层，
  // 公共话术不记名（created_by 留空）。不传 shared 表示"不改变归属"，
  // 这样只改内容时不会把已有的公共话术挪成个人话术。
  const shared = body.shared === undefined ? undefined : Boolean(body.shared)

  if (!title) return { error: '指令标题不能为空' }
  if (title.length > 100) return { error: '指令标题不能超过100个字符' }
  if (!shortcut) return { error: '触发词不能为空' }
  if (shortcut.length > 80) return { error: '触发词不能超过80个字符' }
  if (/\s/.test(shortcut)) return { error: '触发词不能包含空格' }
  if (!content) return { error: '回复内容不能为空' }
  if (content.length > 10000) return { error: '回复内容不能超过10000个字符' }
  if (category.length > 50) return { error: '分类不能超过50个字符' }

  return { data: { title, shortcut, content, category, sortOrder, isEnabled, shared } }
}


const repository = {
  async base(userId) {
    const [rows] = await sequelize.query('SELECT * FROM quick_replies WHERE created_by IS NULL OR created_by = :userId', { replacements: { userId } })
    return rows.map(toPublicQuickReply)
  },
  async personal(userId) { const [rows] = await sequelize.query('SELECT * FROM quick_reply_personal WHERE user_id = :userId', { replacements: { userId } }); return rows },
  async overrides(userId) { const [rows] = await sequelize.query('SELECT * FROM quick_reply_overrides WHERE user_id = :userId', { replacements: { userId } }); return rows },
  async isPersonal(id, userId) { const [rows] = await sequelize.query('SELECT id FROM quick_reply_personal WHERE id = :id AND user_id = :userId', { replacements: { id, userId } }); return rows.length > 0 },
  createPersonal: (id, payload, userId) => sequelize.query('INSERT INTO quick_reply_personal (id, user_id, payload) VALUES (:id, :userId, :payload)', { replacements: { id, userId, payload: JSON.stringify(payload) } }),
  updatePersonal: (id, payload, userId) => sequelize.query('UPDATE quick_reply_personal SET payload = :payload WHERE id = :id AND user_id = :userId', { replacements: { id, userId, payload: JSON.stringify(payload) } }),
  removePersonal: (id, userId) => sequelize.query('DELETE FROM quick_reply_personal WHERE id = :id AND user_id = :userId', { replacements: { id, userId } }),
  saveOverride: (id, payload, hidden, userId) => sequelize.query(`INSERT INTO quick_reply_overrides (user_id, reply_id, hidden, payload) VALUES (:userId, :id, :hidden, :payload)
    ON DUPLICATE KEY UPDATE hidden = VALUES(hidden), payload = VALUES(payload)`, { replacements: { id, userId, hidden, payload: payload ? JSON.stringify(payload) : null } }),
  resetOverrides: userId => sequelize.query('DELETE FROM quick_reply_overrides WHERE user_id = :userId', { replacements: { userId } }),
  createShared: (id, p, userId) => sequelize.query(`INSERT INTO quick_replies (id, title, shortcut, content, category, is_enabled, sort_order, created_by, updated_by, created_at, updated_at)
    VALUES (:id, :title, :shortcut, :content, :category, :isEnabled, :sortOrder, NULL, :userId, NOW(), NOW())`, { replacements: { id, ...p, userId } }),
  updateShared: (id, p, userId) => sequelize.query(`UPDATE quick_replies SET title = :title, shortcut = :shortcut, content = :content, category = :category,
    is_enabled = :isEnabled, sort_order = :sortOrder, updated_by = :userId WHERE id = :id AND created_by IS NULL`, { replacements: { id, ...p, userId } })
}
const service = createQuickReplyPersonalizationService(repository)
router.use(createAuthenticate())
function handle(action) {
  return async (req, res) => {
    try { res.json({ success: true, data: await action(req) }) }
    catch (error) {
      if (error.original?.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: '触发词已存在，请换一个触发词' })
      res.status(error.status || 500).json({ success: false, message: error.status ? error.message : '话术操作失败，请重试' }) }
  }
}
function payload(req) {
  const parsed = validatePayload(req.body)
  if (parsed.error) throw Object.assign(new Error(parsed.error), { status: 400 })
  const { shared, ...data } = parsed.data
  return data
}
router.get('/', handle(req => service.list(req.user, req.query)))
router.post('/', handle(req => service.create(req.user, payload(req), Boolean(req.body.shared))))
router.post('/restore-shared', handle(req => service.reset(req.user)))
router.put('/:id', handle(req => service.update(req.user, req.params.id, payload(req), Boolean(req.body.shared))))
router.patch('/:id/status', handle(req => service.status(req.user, req.params.id, Boolean(req.body.isEnabled))))
router.post('/:id/use', handle(req => service.use(req.user, req.params.id)))
router.delete('/:id', handle(req => service.remove(req.user, req.params.id)))
module.exports = router
