'use strict'

function mappingError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeChannel(value) {
  const channel = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{1,30}$/.test(channel)) throw mappingError('platform_sku_mapping_invalid', 'channel is invalid')
  return channel
}

function normalizeAccountId(value) {
  const accountId = Number(value)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw mappingError('platform_sku_mapping_invalid', 'accountId is invalid')
  return accountId
}

function normalizeSku(value, field, maximum) {
  const sku = String(value || '').trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,190}$/.test(sku) || sku.length > maximum) {
    throw mappingError('platform_sku_mapping_invalid', `${field} is invalid`)
  }
  return sku
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (!['active', 'inactive'].includes(status)) throw mappingError('platform_sku_mapping_invalid', 'status is invalid')
  return status
}

function createPlatformSkuMappingService({ repository }) {
  if (!repository) throw new TypeError('platform SKU mapping repository is required')
  return {
    async list(filters = {}) {
      const limit = Number(filters.limit ?? 200)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw mappingError('platform_sku_mapping_invalid', 'limit is invalid')
      return repository.list({
        channel: filters.channel ? normalizeChannel(filters.channel) : null,
        accountId: filters.accountId == null || filters.accountId === '' ? null : normalizeAccountId(filters.accountId),
        status: filters.status ? normalizeStatus(filters.status) : null,
        limit
      })
    },

    async upsert(input = {}) {
      const operatorId = normalizeAccountId(input.operatorId)
      const normalized = {
        channel: normalizeChannel(input.channel),
        accountId: normalizeAccountId(input.accountId),
        externalSku: normalizeSku(input.externalSku, 'externalSku', 191),
        internalSkuCode: normalizeSku(input.internalSkuCode, 'internalSkuCode', 100),
        status: normalizeStatus(input.status || 'active'),
        createdBy: operatorId
      }
      if (input.id) normalized.id = String(input.id).trim()
      return repository.upsert(normalized)
    },

    async resolve(channel, accountId, externalSku) {
      const row = await repository.find(normalizeChannel(channel), normalizeAccountId(accountId), normalizeSku(externalSku, 'externalSku', 191))
      if (!row || row.status !== 'active') throw mappingError('platform_sku_mapping_unavailable', 'active platform SKU mapping is required')
      return row
    },

    async setStatus(id, status, operatorId) {
      if (!String(id || '').trim()) throw mappingError('platform_sku_mapping_invalid', 'id is required')
      normalizeAccountId(operatorId)
      return repository.setStatus(String(id).trim(), normalizeStatus(status))
    }
  }
}

module.exports = { createPlatformSkuMappingService, mappingError }
