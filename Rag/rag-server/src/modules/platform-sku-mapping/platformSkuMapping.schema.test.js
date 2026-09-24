'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { PLATFORM_SKU_MAPPING_SCHEMA } = require('./platformSkuMapping.schema')

test('platform SKU mapping schema has tenant uniqueness and status indexes', () => {
  assert.match(PLATFORM_SKU_MAPPING_SCHEMA, /CREATE TABLE IF NOT EXISTS platform_sku_mappings/i)
  assert.match(PLATFORM_SKU_MAPPING_SCHEMA, /UNIQUE KEY uk_platform_sku_mapping \(channel, account_id, external_sku\)/i)
  assert.match(PLATFORM_SKU_MAPPING_SCHEMA, /internal_sku_code VARCHAR\(100\)/i)
  assert.match(PLATFORM_SKU_MAPPING_SCHEMA, /INDEX idx_platform_sku_mapping_status/i)
})
