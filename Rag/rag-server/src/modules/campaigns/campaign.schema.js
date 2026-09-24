const CAMPAIGN_TASKS_SCHEMA = `CREATE TABLE IF NOT EXISTS campaign_tasks (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  type VARCHAR(20) NOT NULL,
  target_tags JSON NULL,
  target_channels JSON NOT NULL,
  target_user_ids JSON NOT NULL,
  account_ids JSON NULL,
  scripts JSON NOT NULL,
  daily_limit INT NOT NULL DEFAULT 100,
  interval_seconds INT NOT NULL DEFAULT 30,
  send_time_start VARCHAR(16) NULL,
  send_time_end VARCHAR(16) NULL,
  status ENUM('draft','running','paused','completed','terminated') NOT NULL DEFAULT 'draft',
  total_count INT NOT NULL DEFAULT 0,
  pending_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_campaign_task_status (status, updated_at),
  INDEX idx_campaign_task_creator (created_by, created_at),
  INDEX idx_campaign_task_type (type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

const CAMPAIGN_DELIVERIES_SCHEMA = `CREATE TABLE IF NOT EXISTS campaign_deliveries (
  id VARCHAR(36) PRIMARY KEY,
  task_id VARCHAR(36) NOT NULL,
  account_id INT NOT NULL,
  channel VARCHAR(30) NOT NULL,
  user_id VARCHAR(191) NOT NULL,
  scheduled_at DATETIME NOT NULL,
  status ENUM('scheduled','sending','sent','failed','cancelled') NOT NULL DEFAULT 'scheduled',
  attempt_count INT NOT NULL DEFAULT 0,
  message_json JSON NOT NULL,
  media_file_ids JSON NULL,
  channel_message_id VARCHAR(191) NULL,
  error_message VARCHAR(500) NULL,
  started_at DATETIME NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_campaign_delivery_task (task_id, status, scheduled_at),
  INDEX idx_campaign_delivery_account (account_id, status, scheduled_at),
  INDEX idx_campaign_delivery_status (status, scheduled_at),
  CONSTRAINT fk_campaign_delivery_task FOREIGN KEY (task_id) REFERENCES campaign_tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

const CAMPAIGN_SCHEMA_STATEMENTS = [
  CAMPAIGN_TASKS_SCHEMA,
  CAMPAIGN_DELIVERIES_SCHEMA
]

async function ensureCampaignSchema(sequelize) {
  for (const statement of CAMPAIGN_SCHEMA_STATEMENTS) {
    await sequelize.query(statement)
  }
}

module.exports = {
  CAMPAIGN_TASKS_SCHEMA,
  CAMPAIGN_DELIVERIES_SCHEMA,
  CAMPAIGN_SCHEMA_STATEMENTS,
  ensureCampaignSchema
}
