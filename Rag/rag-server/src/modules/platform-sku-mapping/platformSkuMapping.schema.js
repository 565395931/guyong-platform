'use strict'

const PLATFORM_SKU_MAPPING_SCHEMA = `CREATE TABLE IF NOT EXISTS platform_sku_mappings (
  id VARCHAR(36) PRIMARY KEY,
  channel VARCHAR(30) NOT NULL,
  account_id INT NOT NULL,
  external_sku VARCHAR(191) NOT NULL,
  internal_sku_code VARCHAR(100) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_platform_sku_mapping (channel, account_id, external_sku),
  INDEX idx_platform_sku_mapping_status (status, channel, account_id),
  INDEX idx_platform_sku_mapping_internal (internal_sku_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

async function ensurePlatformSkuMappingSchema(sequelize) {
  await sequelize.query(PLATFORM_SKU_MAPPING_SCHEMA)
}

module.exports = { PLATFORM_SKU_MAPPING_SCHEMA, ensurePlatformSkuMappingSchema }
