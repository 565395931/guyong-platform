const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { sequelize } = require('../../config/database')
const { normalizeKnowledgeMetadata } = require('./knowledgeScope')

const SOURCE_DIR = path.join(__dirname, '..', '..', 'private', 'knowledge-sources')

function ensureSourceDir() {
  if (!fs.existsSync(SOURCE_DIR)) {
    fs.mkdirSync(SOURCE_DIR, { recursive: true })
  }
}

function sanitizeFileName(fileName = 'document') {
  return String(fileName)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n]/g, ' ')
    .trim() || 'document'
}

function normalizeSize(size) {
  const numeric = Number(size)
  return Number.isFinite(numeric) ? numeric : null
}

function parseLocalChunkBaseName(fileName = '') {
  const match = String(fileName).match(/^(.*)_chunk_\d+(?:\.txt)?$/i)
  return match?.[1] || null
}

async function ensureTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS knowledge_document_sources (
      id VARCHAR(36) PRIMARY KEY COMMENT '源文件记录 UUID',
      document_id VARCHAR(100) NULL COMMENT '百炼索引文档 ID',
      file_id VARCHAR(100) NULL COMMENT '百炼数据中心文件 ID',
      job_id VARCHAR(100) NULL COMMENT '索引任务 ID',
      original_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
      stored_name VARCHAR(255) NOT NULL COMMENT '本地存储文件名',
      mime_type VARCHAR(100) NULL COMMENT 'MIME 类型',
      size BIGINT DEFAULT 0 COMMENT '文件大小（字节）',
      storage_path VARCHAR(500) NOT NULL COMMENT '本地存储路径',
      source_mode VARCHAR(20) DEFAULT 'aliyun' COMMENT '上传模式：aliyun/local',
      knowledge_scope VARCHAR(20) DEFAULT 'common' COMMENT '知识适用范围：common/overseas/domestic/channel',
      knowledge_channels JSON NULL COMMENT '适用渠道：all/whatsapp/wechat/douyin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_document_id (document_id),
      INDEX idx_file_id (file_id),
      INDEX idx_job_id (job_id),
      INDEX idx_original_size (original_name, size),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='知识库文档源文件留存表'
  `)

  try {
    await sequelize.query(`ALTER TABLE knowledge_document_sources ADD COLUMN knowledge_scope VARCHAR(20) DEFAULT 'common' COMMENT '知识适用范围：common/overseas/domestic/channel' AFTER source_mode`)
  } catch {}
  try {
    await sequelize.query(`ALTER TABLE knowledge_document_sources ADD COLUMN knowledge_channels JSON NULL COMMENT '适用渠道：all/whatsapp/wechat/douyin' AFTER knowledge_scope`)
  } catch {}
}

async function archiveUploadedFile(file, originalName, metadata = {}) {
  if (!file?.path || !fs.existsSync(file.path)) {
    return null
  }

  ensureSourceDir()
  await ensureTable()

  const safeOriginalName = sanitizeFileName(originalName || file.originalname)
  const ext = path.extname(safeOriginalName).toLowerCase()
  const storedName = `${crypto.randomUUID()}${ext}`
  const storagePath = path.join(SOURCE_DIR, storedName)

  fs.copyFileSync(file.path, storagePath)

  const id = crypto.randomUUID()
  const size = normalizeSize(file.size) ?? fs.statSync(storagePath).size
  const knowledgeMeta = normalizeKnowledgeMetadata(metadata)

  await sequelize.query(
    `INSERT INTO knowledge_document_sources
      (id, document_id, file_id, job_id, original_name, stored_name, mime_type, size, storage_path, source_mode, knowledge_scope, knowledge_channels, created_at, updated_at)
     VALUES
      (:id, :documentId, :fileId, :jobId, :originalName, :storedName, :mimeType, :size, :storagePath, :sourceMode, :knowledgeScope, :knowledgeChannels, NOW(), NOW())`,
    {
      replacements: {
        id,
        documentId: metadata.documentId || null,
        fileId: metadata.fileId || null,
        jobId: metadata.jobId || null,
        originalName: safeOriginalName,
        storedName,
        mimeType: file.mimetype || 'application/octet-stream',
        size,
        storagePath,
        sourceMode: metadata.sourceMode || 'aliyun',
        knowledgeScope: knowledgeMeta.knowledgeScope,
        knowledgeChannels: JSON.stringify(knowledgeMeta.knowledgeChannels)
      }
    }
  )

  return {
    id,
    documentId: metadata.documentId || null,
    fileId: metadata.fileId || null,
    jobId: metadata.jobId || null,
    originalName: safeOriginalName,
    storedName,
    mimeType: file.mimetype || 'application/octet-stream',
    size,
    storagePath,
    sourceMode: metadata.sourceMode || 'aliyun',
    knowledgeScope: knowledgeMeta.knowledgeScope,
    knowledgeChannels: knowledgeMeta.knowledgeChannels
  }
}

async function updateSourceMapping(id, fields = {}) {
  if (!id) return
  await ensureTable()

  const updates = []
  const replacements = { id }
  if (fields.documentId !== undefined) {
    updates.push('document_id = :documentId')
    replacements.documentId = fields.documentId || null
  }
  if (fields.fileId !== undefined) {
    updates.push('file_id = :fileId')
    replacements.fileId = fields.fileId || null
  }
  if (fields.jobId !== undefined) {
    updates.push('job_id = :jobId')
    replacements.jobId = fields.jobId || null
  }
  if (fields.knowledgeScope !== undefined || fields.knowledgeChannels !== undefined || fields.scope !== undefined || fields.channels !== undefined) {
    const knowledgeMeta = normalizeKnowledgeMetadata(fields)
    updates.push('knowledge_scope = :knowledgeScope', 'knowledge_channels = :knowledgeChannels')
    replacements.knowledgeScope = knowledgeMeta.knowledgeScope
    replacements.knowledgeChannels = JSON.stringify(knowledgeMeta.knowledgeChannels)
  }

  if (updates.length === 0) return
  updates.push('updated_at = NOW()')
  await sequelize.query(
    `UPDATE knowledge_document_sources SET ${updates.join(', ')} WHERE id = :id`,
    { replacements }
  )
}

async function findSource({ documentId, fileId, fileName, size } = {}) {
  await ensureTable()

  const conditions = []
  const replacements = {}

  if (documentId) {
    conditions.push('document_id = :documentId')
    replacements.documentId = documentId
  }
  if (fileId) {
    conditions.push('file_id = :fileId')
    replacements.fileId = fileId
  }
  if (fileName) {
    conditions.push('(original_name = :fileName OR original_name = :safeFileName)')
    replacements.fileName = fileName
    replacements.safeFileName = sanitizeFileName(fileName)

    const localChunkBaseName = parseLocalChunkBaseName(fileName)
    if (localChunkBaseName) {
      conditions.push('(source_mode = \'local\' AND original_name LIKE :localSourceName)')
      replacements.localSourceName = `${localChunkBaseName}.%`
    }
  }

  if (conditions.length === 0) return null

  const sizeFilter = normalizeSize(size)
  const sizeSql = sizeFilter !== null ? 'ORDER BY CASE WHEN size = :size THEN 0 ELSE 1 END, updated_at DESC' : 'ORDER BY updated_at DESC'
  if (sizeFilter !== null) replacements.size = sizeFilter

  const [rows] = await sequelize.query(
    `SELECT id, document_id, file_id, job_id, original_name, stored_name, mime_type, size, storage_path, source_mode, knowledge_scope, knowledge_channels, created_at, updated_at
     FROM knowledge_document_sources
     WHERE ${conditions.map(condition => `(${condition})`).join(' OR ')}
     ${sizeSql}
     LIMIT 1`,
    { replacements }
  )

  return rows[0] || null
}

function resolveDownloadPath(source) {
  if (!source?.storage_path) return null
  const resolved = path.resolve(source.storage_path)
  const root = path.resolve(SOURCE_DIR)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('源文件路径不在允许的目录内')
  }
  if (!fs.existsSync(resolved)) return null
  return resolved
}

async function attachDownloadAvailability(documents = []) {
  if (!Array.isArray(documents) || documents.length === 0) return documents
  await ensureTable()

  const sourceLookupCache = new Map()
  const findCachedSource = (doc) => {
    const localChunkBaseName = parseLocalChunkBaseName(doc.fileName)
    const cacheKey = localChunkBaseName
      ? `local:${localChunkBaseName}`
      : `doc:${doc.documentId || ''}:${doc.fileId || doc.sourceFileId || ''}:${doc.fileName || ''}:${doc.size || ''}`

    if (!sourceLookupCache.has(cacheKey)) {
      sourceLookupCache.set(cacheKey, findSource({
        documentId: doc.documentId,
        fileId: doc.fileId || doc.sourceFileId,
        fileName: doc.fileName,
        size: doc.size
      }))
    }

    return sourceLookupCache.get(cacheKey)
  }

  return Promise.all(documents.map(async (doc) => {
    const source = await findCachedSource(doc)
    const downloadPath = source ? resolveDownloadPath(source) : null
    return {
      ...doc,
      downloadAvailable: Boolean(downloadPath),
      sourceArchiveId: source?.id || null,
      sourceOriginalName: source?.original_name || null,
      sourceMode: source?.source_mode || null,
      sourceSize: source?.size ?? null,
      knowledgeScope: source?.knowledge_scope || null,
      knowledgeChannels: typeof source?.knowledge_channels === 'string'
        ? safeJsonParse(source.knowledge_channels, [])
        : (source?.knowledge_channels || [])
    }
  }))
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

module.exports = {
  ensureTable,
  archiveUploadedFile,
  updateSourceMapping,
  findSource,
  resolveDownloadPath,
  attachDownloadAvailability,
  SOURCE_DIR
}
