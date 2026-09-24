const CHANNEL_EVENT_INBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS channel_event_inbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  channel VARCHAR(30) NOT NULL,
  account_id INT NOT NULL,
  external_event_id VARCHAR(160) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  category VARCHAR(30) NOT NULL,
  business_key VARCHAR(160) NULL,
  payload_json JSON NOT NULL,
  status ENUM('received','processed','failed') NOT NULL DEFAULT 'received',
  occurred_at DATETIME NULL,
  processed_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_channel_event_identity (channel, account_id, external_event_id),
  INDEX idx_channel_event_category (channel, category, received_at),
  INDEX idx_channel_event_business (channel, business_key),
  INDEX idx_channel_event_status (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

async function ensureChannelEventInboxSchema(sequelize) {
  await sequelize.query(CHANNEL_EVENT_INBOX_SCHEMA)
}

module.exports = { CHANNEL_EVENT_INBOX_SCHEMA, ensureChannelEventInboxSchema }

