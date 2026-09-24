'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPlatformSkuMappingService } = require('./platformSkuMapping.service')

function memoryRepository() {
  const rows = new Map()
  return {
    rows,
    async upsert(input) {
      const key = `${input.channel}:${input.accountId}:${input.externalSku}`
      const row = { id: input.id || `mapping-${rows.size + 1}`, ...input }
      rows.set(key, row)
      return row
    },
    async list(filters = {}) {
      return [...rows.values()].filter(row => (!filters.channel || row.channel === filters.channel) && (!filters.accountId || row.accountId === filters.accountId))
    },
    async find(channel, accountId, externalSku) { return rows.get(`${channel}:${accountId}:${externalSku}`) || null },
    async setStatus(id, status) {
      const row = [...rows.values()].find(item => item.id === id)
      if (!row) return null
      const updated = { ...row, status }
      rows.set(`${row.channel}:${row.accountId}:${row.externalSku}`, updated)
      return updated
    }
  }
}

test('normalizes and maintains a platform SKU to internal warehouse SKU mapping', async () => {
  const repository = memoryRepository()
  const service = createPlatformSkuMappingService({ repository })
  const created = await service.upsert({ channel: 'Taobao', accountId: '7', externalSku: 'tb-001', internalSkuCode: 'sku-001', operatorId: 9 })
  assert.deepEqual(created, {
    id: 'mapping-1', channel: 'taobao', accountId: 7, externalSku: 'TB-001', internalSkuCode: 'SKU-001', status: 'active', createdBy: 9
  })
  assert.equal((await service.resolve('taobao', 7, 'tb-001')).internalSkuCode, 'SKU-001')
})

test('rejects invalid identity and does not resolve inactive mappings', async () => {
  const repository = memoryRepository()
  const service = createPlatformSkuMappingService({ repository })
  await assert.rejects(() => service.upsert({ channel: 'bad channel', accountId: 1, externalSku: 'x', internalSkuCode: 'y', operatorId: 1 }), error => error.code === 'platform_sku_mapping_invalid')
  const row = await service.upsert({ channel: 'pinduoduo', accountId: 4, externalSku: 'P-1', internalSkuCode: 'SKU-1', operatorId: 1 })
  await service.setStatus(row.id, 'inactive', 1)
  await assert.rejects(() => service.resolve('pinduoduo', 4, 'P-1'), error => error.code === 'platform_sku_mapping_unavailable')
})
