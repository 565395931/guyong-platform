export type SchemaExecutor = Readonly<{
  query: (sql: string) => Promise<readonly [unknown, unknown]>
}>

export const COMMERCE_PROJECTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS commerce_account_mappings (
    id VARCHAR(36) PRIMARY KEY,
    channel VARCHAR(30) NOT NULL,
    account_id INT NOT NULL,
    vendure_channel_id VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_commerce_account_mapping (channel, account_id),
    UNIQUE KEY uk_commerce_vendure_channel (vendure_channel_id),
    INDEX idx_commerce_account_status (status, channel)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS commerce_sku_mappings (
    id VARCHAR(36) PRIMARY KEY,
    channel VARCHAR(30) NOT NULL,
    account_id INT NOT NULL,
    external_sku VARCHAR(191) NOT NULL,
    vendure_product_variant_id VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_commerce_sku_mapping (channel, account_id, external_sku),
    INDEX idx_commerce_sku_variant (vendure_product_variant_id),
    INDEX idx_commerce_sku_status (status, channel, account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS commerce_order_links (
    channel VARCHAR(30) NOT NULL,
    account_id INT NOT NULL,
    external_order_id VARCHAR(160) NOT NULL,
    vendure_order_id VARCHAR(64) NOT NULL,
    order_code VARCHAR(64) NOT NULL,
    external_version VARCHAR(100) NOT NULL,
    normalized_status VARCHAR(30) NOT NULL,
    last_event_inbox_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (channel, account_id, external_order_id),
    UNIQUE KEY uk_commerce_vendure_order (vendure_order_id),
    INDEX idx_commerce_order_status (normalized_status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS commerce_projection_jobs (
    id VARCHAR(36) PRIMARY KEY,
    event_inbox_id BIGINT UNSIGNED NOT NULL,
    command_id VARCHAR(191) NOT NULL,
    command_ref VARCHAR(512) NOT NULL,
    channel VARCHAR(30) NOT NULL,
    account_id INT NOT NULL,
    external_order_id VARCHAR(160) NOT NULL,
    external_version VARCHAR(100) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'processing',
    attempts INT NOT NULL DEFAULT 1,
    next_attempt_at DATETIME(3) NULL,
    locked_at DATETIME(3) NULL,
    last_error_code VARCHAR(80) NULL,
    last_error_message VARCHAR(500) NULL,
    outcome_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_commerce_projection_event (event_inbox_id),
    INDEX idx_commerce_projection_claim (status, next_attempt_at, locked_at),
    INDEX idx_commerce_projection_order (channel, account_id, external_order_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS commerce_projection_audit_logs (
    id VARCHAR(36) PRIMARY KEY,
    job_id VARCHAR(36) NOT NULL,
    actor_id INT NOT NULL,
    action VARCHAR(40) NOT NULL,
    before_status VARCHAR(30) NOT NULL,
    after_status VARCHAR(30) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_commerce_projection_audit_job (job_id, created_at),
    INDEX idx_commerce_projection_audit_actor (actor_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
] as const

export async function ensureCommerceProjectionSchema(executor: SchemaExecutor): Promise<void> {
  for (const statement of COMMERCE_PROJECTION_SCHEMA_STATEMENTS) {
    await executor.query(statement)
  }
}
