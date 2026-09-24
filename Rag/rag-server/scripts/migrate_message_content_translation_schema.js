/*
 * 迁移 plat_messages.content 翻译字段结构
 *
 * 旧结构：
 *   content.text = 中文译文
 *   content.originalText = 客户原文
 *
 * 新结构：
 *   content.text = 客户原文
 *   content.translatedText = 中文译文
 *
 * 默认 dry-run：只统计和预览，不写库。
 * 真正执行：node scripts/migrate_message_content_translation_schema.js --apply
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const { sequelize } = require('../src/config/database')

const APPLY = process.argv.includes('--apply')
const BATCH_SIZE = 500

function parseContent(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function shouldMigrate(content) {
  return !!(
    content &&
    content.translated &&
    content.originalText &&
    content.text &&
    !content.translatedText
  )
}

function migrateContent(content) {
  const oldTranslatedText = content.text
  const originalText = content.originalText
  const next = {
    ...content,
    text: originalText,
    translatedText: oldTranslatedText
  }
  delete next.originalText
  return next
}

async function main() {
  console.log(`[Migration] plat_messages.content 翻译字段结构迁移，模式: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)

  let totalScanned = 0
  let totalMatched = 0
  let totalUpdated = 0
  let lastId = ''
  const previews = []

  while (true) {
    const [rows] = await sequelize.query(
      `SELECT id, conversation_id, content
       FROM plat_messages
       WHERE id > :lastId
       ORDER BY id ASC
       LIMIT :limit`,
      { replacements: { lastId, limit: BATCH_SIZE } }
    )

    if (!rows.length) break

    for (const row of rows) {
      totalScanned++
      lastId = row.id
      const content = parseContent(row.content)
      if (!shouldMigrate(content)) continue

      totalMatched++
      const next = migrateContent(content)

      if (previews.length < 5) {
        previews.push({
          id: row.id,
          conversationId: row.conversation_id,
          before: {
            text: String(content.text).slice(0, 120),
            originalText: String(content.originalText).slice(0, 120),
            translatedText: content.translatedText || null
          },
          after: {
            text: String(next.text).slice(0, 120),
            translatedText: String(next.translatedText).slice(0, 120),
            originalText: next.originalText || null
          }
        })
      }

      if (APPLY) {
        await sequelize.query(
          `UPDATE plat_messages
           SET content = :content, updated_at = NOW()
           WHERE id = :id`,
          { replacements: { id: row.id, content: JSON.stringify(next) } }
        )
        totalUpdated++
      }
    }
  }

  console.log('[Migration] 扫描记录数:', totalScanned)
  console.log('[Migration] 待迁移记录数:', totalMatched)
  console.log('[Migration] 已更新记录数:', totalUpdated)
  console.log('[Migration] 预览前 5 条:')
  console.log(JSON.stringify(previews, null, 2))

  if (!APPLY && totalMatched > 0) {
    console.log('\n[Migration] 当前是 dry-run，未写库。确认预览无误后执行：')
    console.log('node scripts/migrate_message_content_translation_schema.js --apply')
  }
}

main()
  .then(async () => {
    await sequelize.close()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('[Migration] 失败:', err)
    try { await sequelize.close() } catch {}
    process.exit(1)
  })
