const crypto = require('crypto')

const ENTITY_CONFIG = Object.freeze({
  product: {
    table: 'catalog_products',
    key: 'product_code',
    columns: ['product_code', 'name', 'description', 'image_media_id', 'image_url', 'status'],
    orderBy: 'product_code ASC'
  },
  sku: {
    table: 'catalog_skus',
    key: 'sku_code',
    columns: [
      'product_code', 'sku_code', 'specification', 'packaging', 'weight_kg',
      'coverage_min_sqm', 'coverage_max_sqm', 'status'
    ],
    orderBy: 'product_code ASC, sku_code ASC'
  },
  price: {
    table: 'catalog_price_rules',
    key: 'id',
    columns: [
      'sku_code', 'customer_type', 'min_quantity', 'max_quantity', 'unit',
      'currency', 'unit_price', 'effective_from', 'effective_to', 'status'
    ],
    orderBy: 'sku_code ASC, min_quantity ASC'
  },
  freight: {
    table: 'catalog_freight_rules',
    key: 'id',
    columns: [
      'region_code', 'delivery_term', 'base_weight_kg', 'base_fee',
      'incremental_weight_kg', 'incremental_fee', 'currency',
      'manual_confirmation', 'effective_from', 'effective_to', 'status'
    ],
    orderBy: 'region_code ASC, delivery_term ASC'
  }
})

const COPY_COLUMNS = Object.freeze({
  catalog_products: 'product_code,name,description,image_media_id,image_url,status',
  catalog_skus: 'product_code,sku_code,specification,packaging,weight_kg,coverage_min_sqm,coverage_max_sqm,status',
  catalog_price_rules: 'sku_code,customer_type,min_quantity,max_quantity,unit,currency,unit_price,effective_from,effective_to,status',
  catalog_freight_rules: 'region_code,delivery_term,base_weight_kg,base_fee,incremental_weight_kg,incremental_fee,currency,manual_confirmation,effective_from,effective_to,status'
})

function parseJson(value) {
  if (value == null || typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function createRepository(sequelize) {
  function configFor(kind) {
    const config = ENTITY_CONFIG[kind]
    if (!config) throw new Error('unsupported catalog entity')
    return config
  }

  async function listVersioned(kind, versionId) {
    const config = configFor(kind)
    const [rows] = await sequelize.query(
      `SELECT * FROM ${config.table} WHERE version_id=:versionId ORDER BY ${config.orderBy}`,
      { replacements: { versionId } }
    )
    return rows
  }

  async function upsertVersioned(kind, versionId, input, transaction) {
    const config = configFor(kind)
    const id = input.id || crypto.randomUUID()
    const replacements = { id, version_id: versionId }
    for (const column of config.columns) replacements[column] = input[column] ?? null

    const columns = ['id', 'version_id', ...config.columns]
    const updates = config.columns
      .filter(column => column !== config.key)
      .map(column => `${column}=VALUES(${column})`)
    await sequelize.query(
      `INSERT INTO ${config.table} (${columns.join(',')})
       VALUES (${columns.map(column => `:${column}`).join(',')})
       ON DUPLICATE KEY UPDATE ${updates.join(',')}, updated_at=NOW()`,
      { replacements, transaction }
    )

    const lookupValue = config.key === 'id' ? id : replacements[config.key]
    const [rows] = await sequelize.query(
      `SELECT * FROM ${config.table} WHERE version_id=:versionId AND ${config.key}=:lookupValue LIMIT 1`,
      { replacements: { versionId, lookupValue }, transaction }
    )
    return rows[0] || { id, version_id: versionId, ...Object.fromEntries(config.columns.map(column => [column, replacements[column]])) }
  }

  async function deleteVersioned(kind, versionId, id, transaction) {
    const config = configFor(kind)
    return sequelize.query(
      `DELETE FROM ${config.table} WHERE version_id=:versionId AND id=:id`,
      { replacements: { versionId, id }, transaction }
    )
  }

  return {
    listVersioned,
    upsertVersioned,
    deleteVersioned,
    transaction: fn => sequelize.transaction(fn),

    async listVersions() {
      const [rows] = await sequelize.query(
        'SELECT * FROM catalog_versions ORDER BY created_at DESC'
      )
      return rows
    },

    async getVersion(id, transaction) {
      const [rows] = await sequelize.query(
        'SELECT * FROM catalog_versions WHERE id=:id LIMIT 1',
        { replacements: { id }, transaction }
      )
      return rows[0] || null
    },

    async createDraftFromPublished(userId, now = new Date()) {
      return sequelize.transaction(async transaction => {
        const id = crypto.randomUUID()
        const timestamp = now.toISOString().replace(/\D/g, '').slice(0, 14)
        const versionNo = `CAT-${timestamp}-${id.slice(0, 6).toUpperCase()}`
        await sequelize.query(
          `INSERT INTO catalog_versions (id,version_no,status,created_by)
           VALUES (:id,:versionNo,'draft',:userId)`,
          { replacements: { id, versionNo, userId }, transaction }
        )
        const [published] = await sequelize.query(
          `SELECT id FROM catalog_versions
           WHERE status='published' ORDER BY published_at DESC LIMIT 1`,
          { transaction }
        )
        if (published[0]) {
          for (const [table, columns] of Object.entries(COPY_COLUMNS)) {
            await sequelize.query(
              `INSERT INTO ${table} (id,version_id,${columns})
               SELECT UUID(),:draftId,${columns} FROM ${table} WHERE version_id=:publishedId`,
              {
                replacements: { draftId: id, publishedId: published[0].id },
                transaction
              }
            )
          }
        }
        return { id, version_no: versionNo, status: 'draft' }
      })
    },

    retirePublished(transaction) {
      return sequelize.query(
        `UPDATE catalog_versions SET status='retired',updated_at=NOW()
         WHERE status='published'`,
        { transaction }
      )
    },

    publishVersion(id, userId, transaction) {
      return sequelize.query(
        `UPDATE catalog_versions
         SET status='published',published_by=:userId,published_at=NOW(),updated_at=NOW()
         WHERE id=:id AND status='draft'`,
        { replacements: { id, userId }, transaction }
      )
    },

    listProducts: versionId => listVersioned('product', versionId),
    listSkus: versionId => listVersioned('sku', versionId),
    listPriceRules: versionId => listVersioned('price', versionId),
    listFreightRules: versionId => listVersioned('freight', versionId),
    upsertProduct: (versionId, input, transaction) => upsertVersioned('product', versionId, input, transaction),
    upsertSku: (versionId, input, transaction) => upsertVersioned('sku', versionId, input, transaction),
    upsertPriceRule: (versionId, input, transaction) => upsertVersioned('price', versionId, input, transaction),
    upsertFreightRule: (versionId, input, transaction) => upsertVersioned('freight', versionId, input, transaction),

    async findCommittedImportByHash(sourceHash) {
      const [rows] = await sequelize.query(
        `SELECT id,committed_version_id FROM catalog_import_jobs
         WHERE source_hash=:sourceHash AND status='committed' LIMIT 1`,
        { replacements: { sourceHash } }
      )
      return rows[0] || null
    },

    async createImportJob(row) {
      const id = crypto.randomUUID()
      await sequelize.query(
        `INSERT INTO catalog_import_jobs
         (id,filename,source_hash,status,preview_json,created_by)
         VALUES (:id,:filename,:sourceHash,:status,:previewJson,:createdBy)`,
        {
          replacements: {
            id,
            filename: row.filename,
            sourceHash: row.sourceHash,
            status: row.status,
            previewJson: JSON.stringify(row.previewJson),
            createdBy: row.createdBy || null
          }
        }
      )
      return { id, ...row }
    },

    async getImportJob(id) {
      const [rows] = await sequelize.query(
        'SELECT * FROM catalog_import_jobs WHERE id=:id LIMIT 1',
        { replacements: { id } }
      )
      const row = rows[0]
      if (row) row.preview_json = parseJson(row.preview_json)
      return row || null
    },

    markImportCommitted(id, versionId) {
      return sequelize.query(
        `UPDATE catalog_import_jobs
         SET status='committed',committed_version_id=:versionId,updated_at=NOW()
         WHERE id=:id AND status='previewed'`,
        { replacements: { id, versionId } }
      )
    },

    async writeAudit(row) {
      await sequelize.query(
        `INSERT INTO catalog_audit_logs
         (id,entity_type,entity_id,action,before_json,after_json,operator_id)
         VALUES (UUID(),:entityType,:entityId,:action,:beforeJson,:afterJson,:operatorId)`,
        {
          replacements: {
            entityType: row.entityType,
            entityId: row.entityId,
            action: row.action,
            beforeJson: row.beforeJson ? JSON.stringify(row.beforeJson) : null,
            afterJson: row.afterJson ? JSON.stringify(row.afterJson) : null,
            operatorId: row.operatorId || null
          },
          transaction: row.transaction
        }
      )
    },

    async loadPublishedCatalog(now = new Date()) {
      const [versions] = await sequelize.query(
        `SELECT * FROM catalog_versions
         WHERE status='published' ORDER BY published_at DESC LIMIT 1`
      )
      if (!versions[0]) return null
      const versionId = versions[0].id
      const effectiveSql = `version_id=:versionId AND status='active'
        AND (effective_from IS NULL OR effective_from<=:now)
        AND (effective_to IS NULL OR effective_to>:now)`
      const [priceRules] = await sequelize.query(
        `SELECT * FROM catalog_price_rules WHERE ${effectiveSql}`,
        { replacements: { versionId, now } }
      )
      const [freightRules] = await sequelize.query(
        `SELECT * FROM catalog_freight_rules WHERE ${effectiveSql}`,
        { replacements: { versionId, now } }
      )
      return { versionId, priceRules, freightRules }
    },

    async createQuoteRecord(row) {
      const id = crypto.randomUUID()
      await sequelize.query(
        `INSERT INTO quote_records
         (id,customer_id,conversation_id,channel,account_id,sku_code,quantity,
          customer_type,region_code,delivery_term,version_id,price_rule_id,
          freight_rule_id,result_json,created_by)
         VALUES (:id,:customerId,:conversationId,:channel,:accountId,:skuCode,
          :quantity,:customerType,:regionCode,:deliveryTerm,:versionId,:priceRuleId,
          :freightRuleId,:resultJson,:createdBy)`,
        {
          replacements: {
            id,
            customerId: row.customerId || null,
            conversationId: row.conversationId || null,
            channel: row.channel || null,
            accountId: row.accountId || null,
            skuCode: row.skuCode,
            quantity: row.quantity,
            customerType: row.customerType,
            regionCode: row.regionCode || null,
            deliveryTerm: row.deliveryTerm || null,
            versionId: row.result.versionId || null,
            priceRuleId: row.result.priceRuleId || null,
            freightRuleId: row.result.freightRuleId || null,
            resultJson: JSON.stringify(row.result),
            createdBy: row.createdBy || null
          }
        }
      )
      return { id, ...row.result }
    }
  }
}

module.exports = { createRepository, ENTITY_CONFIG }
