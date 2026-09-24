/**
 * 媒体文件管理 API
 *
 * 用于后台上传可发送到 WhatsApp 的图片、视频和通用文件，聚合工作台可选择后发送。
 */

const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { sequelize } = require('../config/database')

const JWT_SECRET = process.env.JWT_SECRET
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'rag_secret_key_2024_dev_only'
const MEDIA_DIR = path.join(__dirname, '..', 'public', 'media-files')
const PUBLIC_PREFIX = '/api/media-files/static'

const allowedExts = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.mp4', '.mov', '.m4v', '.webm',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.zip', '.rar'
])

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
  }
}

function decodeOriginalName(name = '') {
  try {
    return Buffer.from(name, 'latin1').toString('utf8')
  } catch {
    return name || 'file'
  }
}

function getMediaType(mimetype = '', ext = '') {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('video/')) return 'video'
  if (mimetype.startsWith('audio/')) return 'audio'
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.webm'].includes(ext)) return 'video'
  if (['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus'].includes(ext)) return 'audio'
  return 'file'
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

function toPublicFile(row, req) {
  const baseUrl = getBaseUrl(req)
  return {
    id: row.id,
    originalName: row.original_name,
    displayName: row.display_name || row.original_name,
    description: row.description || '',
    filename: row.filename,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    size: Number(row.size || 0),
    url: row.url,
    fullUrl: `${baseUrl}${row.url}`,
    uploaderId: row.uploader_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
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
      return res.status(403).json({ success: false, message: '无权限访问媒体文件' })
    }
    next()
  } catch (err) {
    return res.status(401).json({ success: false, message: '认证失败: ' + err.message })
  }
})

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureMediaDir()
      cb(null, MEDIA_DIR)
    },
    filename: (req, file, cb) => {
      const originalName = decodeOriginalName(file.originalname)
      const ext = path.extname(originalName).toLowerCase()
      const safeName = crypto.randomUUID() + ext
      cb(null, safeName)
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const originalName = decodeOriginalName(file.originalname)
    const ext = path.extname(originalName).toLowerCase()
    if (!allowedExts.has(ext)) {
      return cb(new Error('不支持的文件类型'))
    }
    cb(null, true)
  }
})

// ========== 文件列表 ==========
router.get('/', async (req, res) => {
  try {
    const { mediaType = '', keyword = '', page = 1, pageSize = 20 } = req.query
    const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100)
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit
    const replacements = { limit, offset }
    const where = []

    if (['image', 'video', 'audio', 'file'].includes(mediaType)) {
      where.push('media_type = :mediaType')
      replacements.mediaType = mediaType
    }
    if (keyword) {
      where.push('(original_name LIKE :keyword OR display_name LIKE :keyword OR description LIKE :keyword)')
      replacements.keyword = `%${keyword}%`
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [rows] = await sequelize.query(
      `SELECT id, original_name, display_name, description, filename, media_type, mime_type, size, url, uploader_id, created_at, updated_at
       FROM media_files
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    )
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM media_files ${whereSql}`,
      { replacements }
    )

    res.json({
      success: true,
      data: {
        list: rows.map(row => toPublicFile(row, req)),
        total: Number(countRows[0]?.total || 0)
      }
    })
  } catch (err) {
    console.error('[MediaFiles] 查询列表失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败: ' + err.message })
  }
})

async function saveUploadedFile(req, file) {
  const originalName = decodeOriginalName(file.originalname)
  const ext = path.extname(originalName).toLowerCase()
  const mediaType = getMediaType(file.mimetype, ext)
  const url = `${PUBLIC_PREFIX}/${file.filename}`
  const uploaderId = req.user.id || req.user.userId || null
  const id = crypto.randomUUID()

  await sequelize.query(
    `INSERT INTO media_files
      (id, original_name, display_name, description, filename, media_type, mime_type, size, storage_path, url, uploader_id, created_at, updated_at)
     VALUES
      (:id, :originalName, :displayName, '', :filename, :mediaType, :mimeType, :size, :storagePath, :url, :uploaderId, NOW(), NOW())`,
    {
      replacements: {
        id,
        originalName,
        displayName: originalName,
        filename: file.filename,
        mediaType,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
        storagePath: file.path,
        url,
        uploaderId
      }
    }
  )

  const [rows] = await sequelize.query(
    `SELECT id, original_name, display_name, description, filename, media_type, mime_type, size, url, uploader_id, created_at, updated_at
     FROM media_files WHERE id = :id LIMIT 1`,
    { replacements: { id } }
  )

  return toPublicFile(rows[0], req)
}

// ========== 上传文件（支持单文件 file 与批量 files） ==========
router.post('/upload', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'files', maxCount: 50 }
]), async (req, res) => {
  const uploadedFiles = [
    ...(req.files?.file || []),
    ...(req.files?.files || [])
  ]

  try {
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要上传的文件' })
    }

    const savedFiles = []
    for (const file of uploadedFiles) {
      savedFiles.push(await saveUploadedFile(req, file))
    }

    res.json({
      success: true,
      data: {
        list: savedFiles,
        total: savedFiles.length,
        file: savedFiles[0]
      },
      message: savedFiles.length === 1 ? '上传成功' : `成功上传 ${savedFiles.length} 个文件`
    })
  } catch (err) {
    console.error('[MediaFiles] 上传失败:', err.message)
    for (const file of uploadedFiles) {
      if (file?.path && fs.existsSync(file.path)) {
        fs.unlink(file.path, () => {})
      }
    }
    res.status(400).json({ success: false, message: '上传失败: ' + err.message })
  }
})

// ========== 更新文件信息 ==========
router.put('/:id', async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '仅管理员或主管可编辑文件信息' })
    }

    const { displayName = '', description = '' } = req.body || {}
    const cleanDisplayName = String(displayName || '').trim()
    const cleanDescription = String(description || '').trim()

    if (!cleanDisplayName) {
      return res.status(400).json({ success: false, message: '文件名不能为空' })
    }
    if (cleanDisplayName.length > 255) {
      return res.status(400).json({ success: false, message: '文件名不能超过255个字符' })
    }
    if (cleanDescription.length > 2000) {
      return res.status(400).json({ success: false, message: '文件描述不能超过2000个字符' })
    }

    const [existing] = await sequelize.query(
      `SELECT id FROM media_files WHERE id = :id`,
      { replacements: { id: req.params.id } }
    )
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: '文件不存在' })
    }

    await sequelize.query(
      `UPDATE media_files
       SET display_name = :displayName, description = :description, updated_at = NOW()
       WHERE id = :id`,
      { replacements: { id: req.params.id, displayName: cleanDisplayName, description: cleanDescription } }
    )

    const [rows] = await sequelize.query(
      `SELECT id, original_name, display_name, description, filename, media_type, mime_type, size, url, uploader_id, created_at, updated_at
       FROM media_files WHERE id = :id LIMIT 1`,
      { replacements: { id: req.params.id } }
    )

    res.json({ success: true, data: toPublicFile(rows[0], req), message: '保存成功' })
  } catch (err) {
    console.error('[MediaFiles] 更新失败:', err.message)
    res.status(500).json({ success: false, message: '更新失败: ' + err.message })
  }
})

// ========== 删除文件 ==========
router.delete('/:id', async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: '仅管理员或主管可删除文件' })
    }

    const [rows] = await sequelize.query(
      `SELECT id, storage_path FROM media_files WHERE id = :id`,
      { replacements: { id: req.params.id } }
    )
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '文件不存在' })
    }

    await sequelize.query(`DELETE FROM media_files WHERE id = :id`, { replacements: { id: req.params.id } })
    const storagePath = rows[0].storage_path
    if (storagePath && fs.existsSync(storagePath)) {
      fs.unlink(storagePath, () => {})
    }

    res.json({ success: true, message: '删除成功' })
  } catch (err) {
    console.error('[MediaFiles] 删除失败:', err.message)
    res.status(500).json({ success: false, message: '删除失败: ' + err.message })
  }
})

module.exports = router
