'use strict'

const WAREHOUSE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS warehouses (
    id VARCHAR(36) PRIMARY KEY,
    code VARCHAR(40) NOT NULL,
    name VARCHAR(120) NOT NULL,
    status ENUM('active','inactive') NOT NULL DEFAULT 'active',
    created_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_warehouse_code (code),
    INDEX idx_warehouse_status (status, code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS warehouse_inventory (
    id VARCHAR(36) PRIMARY KEY,
    warehouse_id VARCHAR(36) NOT NULL,
    sku_code VARCHAR(100) NOT NULL,
    on_hand_quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
    reserved_quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_warehouse_inventory_item (warehouse_id, sku_code),
    INDEX idx_warehouse_inventory_sku (sku_code, warehouse_id),
    CONSTRAINT chk_warehouse_inventory_nonnegative CHECK (on_hand_quantity >= 0 AND reserved_quantity >= 0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS warehouse_reservations (
    id VARCHAR(36) PRIMARY KEY,
    reservation_key VARCHAR(160) NOT NULL,
    order_ref VARCHAR(160) NOT NULL,
    warehouse_id VARCHAR(36) NOT NULL,
    status ENUM('reserved','released','fulfilled') NOT NULL,
    lines_json JSON NOT NULL,
    created_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_warehouse_reservation_key (reservation_key),
    INDEX idx_warehouse_reservation_order (order_ref, status),
    INDEX idx_warehouse_reservation_warehouse (warehouse_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS warehouse_inventory_ledger (
    id VARCHAR(36) PRIMARY KEY,
    warehouse_id VARCHAR(36) NOT NULL,
    sku_code VARCHAR(100) NOT NULL,
    operation_key VARCHAR(160) NOT NULL,
    operation_type ENUM('receipt','adjustment','reserve','release','fulfill') NOT NULL,
    on_hand_delta DECIMAL(18,3) NOT NULL DEFAULT 0,
    reserved_delta DECIMAL(18,3) NOT NULL DEFAULT 0,
    reference_key VARCHAR(160) NULL,
    quantity DECIMAL(18,3) NOT NULL,
    metadata_json JSON NULL,
    created_by INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_warehouse_operation (operation_key),
    INDEX idx_warehouse_ledger_item (warehouse_id, sku_code, created_at),
    INDEX idx_warehouse_ledger_reference (reference_key, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

async function ensureWarehouseSchema(sequelize) {
  for (const statement of WAREHOUSE_SCHEMA_STATEMENTS) await sequelize.query(statement)
}

module.exports = { WAREHOUSE_SCHEMA_STATEMENTS, ensureWarehouseSchema }
