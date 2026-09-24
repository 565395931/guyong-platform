const CHANNEL_SYNC_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS channel_sync_state (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  channel VARCHAR(30) NOT NULL,
  account_id INT NOT NULL,
  resource ENUM('order','after_sales') NOT NULL,
  cursor_at DATETIME NOT NULL,
  last_attempt_at DATETIME NULL,
  last_success_at DATETIME NULL,
  failure_count INT NOT NULL DEFAULT 0,
  last_error_code VARCHAR(100) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_channel_sync_state (channel, account_id, resource),
  INDEX idx_channel_sync_due (channel, resource, cursor_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

async function ensureChannelSyncStateSchema(sequelize) {
  await sequelize.query(CHANNEL_SYNC_STATE_SCHEMA)
}

module.exports = { CHANNEL_SYNC_STATE_SCHEMA, ensureChannelSyncStateSchema }
