'use strict'

const ORDER_FULFILLMENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS order_fulfillments (
    id VARCHAR(36) PRIMARY KEY,
    order_id VARCHAR(36) NOT NULL,
    warehouse_code VARCHAR(40) NOT NULL,
    reservation_key VARCHAR(160) NOT NULL,
    status ENUM('reserved','shipped','cancelled','failed') NOT NULL DEFAULT 'reserved',
    channel VARCHAR(30) NULL,
    account_id INT NULL,
    external_order_id VARCHAR(160) NULL,
    lines_json JSON NOT NULL,
    last_error VARCHAR(500) NULL,
    created_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_order_fulfillment_order (order_id),
    UNIQUE KEY uk_order_fulfillment_reservation (reservation_key),
    INDEX idx_order_fulfillment_status (status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS fulfillment_writeback_outbox (
    id VARCHAR(36) PRIMARY KEY,
    fulfillment_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    channel VARCHAR(30) NULL,
    account_id INT NULL,
    external_order_id VARCHAR(160) NULL,
    payload_json JSON NOT NULL,
    status ENUM('pending','processing','succeeded','failed') NOT NULL DEFAULT 'pending',
    attempt_count INT NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_fulfillment_writeback_event (fulfillment_id, event_type),
    INDEX idx_fulfillment_writeback_due (status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

async function ensureOrderFulfillmentSchema(sequelize) {
  for (const statement of ORDER_FULFILLMENT_SCHEMA_STATEMENTS) await sequelize.query(statement)
}

module.exports = { ORDER_FULFILLMENT_SCHEMA_STATEMENTS, ensureOrderFulfillmentSchema }
