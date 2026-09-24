const CATALOG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS catalog_versions (
    id VARCHAR(36) PRIMARY KEY,
    version_no VARCHAR(40) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    source_type VARCHAR(30) NULL,
    source_hash VARCHAR(64) NULL,
    created_by INT NULL,
    published_by INT NULL,
    published_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalog_version_status (status, published_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_products (
    id VARCHAR(36) PRIMARY KEY,
    version_id VARCHAR(36) NOT NULL,
    product_code VARCHAR(80) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    image_media_id VARCHAR(36) NULL,
    image_url VARCHAR(500) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_catalog_product_version_code (version_id, product_code),
    INDEX idx_catalog_product_version (version_id, status),
    INDEX idx_catalog_product_image (image_media_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_skus (
    id VARCHAR(36) PRIMARY KEY,
    version_id VARCHAR(36) NOT NULL,
    product_code VARCHAR(80) NOT NULL,
    sku_code VARCHAR(100) NOT NULL,
    specification VARCHAR(255) NULL,
    packaging VARCHAR(255) NULL,
    weight_kg DECIMAL(12,3) NULL,
    coverage_min_sqm DECIMAL(12,2) NULL,
    coverage_max_sqm DECIMAL(12,2) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_catalog_sku_version_code (version_id, sku_code),
    INDEX idx_catalog_sku_product (version_id, product_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_price_rules (
    id VARCHAR(36) PRIMARY KEY,
    version_id VARCHAR(36) NOT NULL,
    sku_code VARCHAR(100) NOT NULL,
    customer_type VARCHAR(20) NOT NULL DEFAULT 'all',
    min_quantity DECIMAL(12,3) NOT NULL,
    max_quantity DECIMAL(12,3) NULL,
    unit VARCHAR(20) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    effective_from DATETIME NULL,
    effective_to DATETIME NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalog_price_lookup (version_id, sku_code, currency, min_quantity),
    INDEX idx_catalog_price_effective (version_id, status, effective_from, effective_to)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_freight_rules (
    id VARCHAR(36) PRIMARY KEY,
    version_id VARCHAR(36) NOT NULL,
    region_code VARCHAR(30) NOT NULL,
    delivery_term VARCHAR(20) NOT NULL DEFAULT 'OTHER',
    base_weight_kg DECIMAL(12,3) NOT NULL,
    base_fee DECIMAL(12,2) NULL,
    incremental_weight_kg DECIMAL(12,3) NULL,
    incremental_fee DECIMAL(12,2) NULL,
    currency VARCHAR(10) NOT NULL,
    manual_confirmation TINYINT(1) NOT NULL DEFAULT 0,
    effective_from DATETIME NULL,
    effective_to DATETIME NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalog_freight_lookup (version_id, region_code, delivery_term),
    INDEX idx_catalog_freight_effective (version_id, status, effective_from, effective_to)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_import_jobs (
    id VARCHAR(36) PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    source_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    preview_json JSON NOT NULL,
    committed_version_id VARCHAR(36) NULL,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalog_import_hash (source_hash, status),
    INDEX idx_catalog_import_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_audit_logs (
    id VARCHAR(36) PRIMARY KEY,
    entity_type VARCHAR(40) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    action VARCHAR(40) NOT NULL,
    before_json JSON NULL,
    after_json JSON NULL,
    operator_id INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_catalog_audit_entity (entity_type, entity_id, created_at),
    INDEX idx_catalog_audit_operator (operator_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS quote_records (
    id VARCHAR(36) PRIMARY KEY,
    customer_id VARCHAR(36) NULL,
    conversation_id VARCHAR(36) NULL,
    channel VARCHAR(30) NULL,
    account_id INT NULL,
    sku_code VARCHAR(100) NOT NULL,
    quantity DECIMAL(12,3) NOT NULL,
    customer_type VARCHAR(20) NOT NULL,
    region_code VARCHAR(30) NULL,
    delivery_term VARCHAR(20) NULL,
    version_id VARCHAR(36) NULL,
    price_rule_id VARCHAR(36) NULL,
    freight_rule_id VARCHAR(36) NULL,
    result_json JSON NOT NULL,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_quote_customer (customer_id, created_at),
    INDEX idx_quote_conversation (conversation_id, created_at),
    INDEX idx_quote_version (version_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

async function ensureCatalogSchema(sequelize) {
  for (const statement of CATALOG_SCHEMA_STATEMENTS) {
    await sequelize.query(statement)
  }
  for (const migration of [
    `ALTER TABLE catalog_products ADD COLUMN image_media_id VARCHAR(36) NULL AFTER description`,
    `ALTER TABLE catalog_products ADD COLUMN image_url VARCHAR(500) NULL AFTER image_media_id`,
    `ALTER TABLE catalog_products ADD INDEX idx_catalog_product_image (image_media_id)`
  ]) {
    try { await sequelize.query(migration) } catch { /* Existing installations already have this column/index. */ }
  }
}

module.exports = { ensureCatalogSchema, CATALOG_SCHEMA_STATEMENTS }
