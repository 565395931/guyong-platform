'use strict'

const { randomUUID } = require('node:crypto')

function createPlatformSkuMappingRepository(sequelize) {
  if (!sequelize || typeof sequelize.query !== 'function') throw new TypeError('platform SKU mapping repository requires Sequelize')
  return {
    async list(filters = {}) {
      const conditions = []
      const replacements = { limit: filters.limit || 200 }
      if (filters.channel) { conditions.push('channel = :channel'); replacements.channel = filters.channel }
      if (filters.accountId) { conditions.push('account_id = :accountId'); replacements.accountId = filters.accountId }
      if (filters.status) { conditions.push('status = :status'); replacements.status = filters.status }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const [rows] = await sequelize.query(
        `SELECT id, channel, account_id AS accountId, external_sku AS externalSku,
                internal_sku_code AS internalSkuCode, status, created_by AS createdBy,
                created_at AS createdAt, updated_at AS updatedAt
           FROM platform_sku_mappings ${where}
          ORDER BY channel, account_id, external_sku LIMIT :limit`,
        { replacements }
      )
      return rows
    },

    async find(channel, accountId, externalSku) {
      const [rows] = await sequelize.query(
        `SELECT id, channel, account_id AS accountId, external_sku AS externalSku,
                internal_sku_code AS internalSkuCode, status, created_by AS createdBy,
                created_at AS createdAt, updated_at AS updatedAt
           FROM platform_sku_mappings
          WHERE channel=:channel AND account_id=:accountId AND external_sku=:externalSku
          LIMIT 1`,
        { replacements: { channel, accountId, externalSku } }
      )
      return rows[0] || null
    },

    async findById(id) {
      const [rows] = await sequelize.query(
        'SELECT id, channel, account_id AS accountId, external_sku AS externalSku, internal_sku_code AS internalSkuCode, status, created_by AS createdBy FROM platform_sku_mappings WHERE id=:id LIMIT 1',
        { replacements: { id } }
      )
      return rows[0] || null
    },

    async upsert(input) {
      const id = input.id || randomUUID()
      await sequelize.query(
        `INSERT INTO platform_sku_mappings
          (id, channel, account_id, external_sku, internal_sku_code, status, created_by)
         VALUES (:id, :channel, :accountId, :externalSku, :internalSkuCode, :status, :createdBy)
         ON DUPLICATE KEY UPDATE internal_sku_code=VALUES(internal_sku_code),
           status=VALUES(status), updated_at=CURRENT_TIMESTAMP(3)`,
        { replacements: { ...input, id } }
      )
      return this.find(input.channel, input.accountId, input.externalSku)
    },

    async setStatus(id, status) {
      await sequelize.query(
        'UPDATE platform_sku_mappings SET status=:status, updated_at=CURRENT_TIMESTAMP(3) WHERE id=:id',
        { replacements: { id, status } }
      )
      return this.findById(id)
    }
  }
}

module.exports = { createPlatformSkuMappingRepository }
