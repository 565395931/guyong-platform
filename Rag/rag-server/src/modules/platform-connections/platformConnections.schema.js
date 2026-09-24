async function hasColumn(sequelize, tableName, columnName) {
  const [rows] = await sequelize.query(
    `SELECT 1 AS found FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tableName AND COLUMN_NAME = :columnName
     LIMIT 1`,
    { replacements: { tableName, columnName } }
  )
  return rows.length > 0
}

async function hasIndex(sequelize, tableName, indexName) {
  const [rows] = await sequelize.query(
    `SELECT 1 AS found FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tableName AND INDEX_NAME = :indexName
     LIMIT 1`,
    { replacements: { tableName, indexName } }
  )
  return rows.length > 0
}

const ACCOUNT_COLUMNS = Object.freeze({
  connection_id: 'INT NULL COMMENT \'企业平台连接 ID\'',
  external_account_id: 'VARCHAR(160) NULL COMMENT \'平台客服账号 ID，如 open_kfid\'',
  avatar_url: 'VARCHAR(500) NULL COMMENT \'平台账号头像\'',
  protection_level: "ENUM('locked','test','none') NOT NULL DEFAULT 'locked' COMMENT '账号保护等级'",
  locked_reason: 'VARCHAR(100) NULL COMMENT \'锁定原因\'',
  ai_enabled: 'TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'是否允许 AI 自动发送\'',
  allowlist_enabled: 'TINYINT(1) NOT NULL DEFAULT 1 COMMENT \'是否要求测试白名单\'',
  sync_status: "ENUM('synced','missing','error') NOT NULL DEFAULT 'synced' COMMENT '平台同步状态'",
  last_inbound_at: 'DATETIME NULL COMMENT \'最近入站时间\'',
  last_outbound_at: 'DATETIME NULL COMMENT \'最近出站时间\''
})

async function ensurePlatformConnectionsSchema(sequelize) {
  const createStatements = [
    `CREATE TABLE IF NOT EXISTS platform_connections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      channel_code VARCHAR(30) NOT NULL DEFAULT 'wecom_kf',
      connection_name VARCHAR(120) NOT NULL,
      corp_id VARCHAR(160) NOT NULL,
      credential_ciphertext TEXT NOT NULL,
      callback_key VARCHAR(64) NOT NULL,
      status ENUM('draft','verified','active','disabled','error') NOT NULL DEFAULT 'draft',
      health_status ENUM('unknown','healthy','error') NOT NULL DEFAULT 'unknown',
      health_message VARCHAR(500) NULL,
      account_count INT NOT NULL DEFAULT 0,
      config_version INT NOT NULL DEFAULT 1,
      last_token_refresh_at DATETIME NULL,
      last_callback_at DATETIME NULL,
      last_sync_at DATETIME NULL,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_platform_connection_channel_corp (channel_code, corp_id),
      UNIQUE KEY uk_platform_connection_callback_key (callback_key),
      INDEX idx_platform_connection_status (status, health_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS channel_account_allowlists (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      external_user_id VARCHAR(160) NOT NULL,
      label VARCHAR(120) NULL,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_account_allowlist_identity (account_id, external_user_id),
      INDEX idx_account_allowlist_status (account_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS channel_sync_states (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      connection_id INT NOT NULL,
      stream_key VARCHAR(80) NOT NULL DEFAULT 'messages',
      cursor_value TEXT NULL,
      last_success_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      retry_count INT NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_channel_sync_stream (connection_id, stream_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS channel_operation_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      connection_id INT NULL,
      account_id INT NULL,
      action VARCHAR(60) NOT NULL,
      before_json JSON NULL,
      after_json JSON NULL,
      operator_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_channel_operation_connection (connection_id, created_at),
      INDEX idx_channel_operation_account (account_id, created_at),
      INDEX idx_channel_operation_operator (operator_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ]

  for (const sql of createStatements) await sequelize.query(sql)

  for (const [columnName, definition] of Object.entries(ACCOUNT_COLUMNS)) {
    if (!await hasColumn(sequelize, 'channel_accounts', columnName)) {
      await sequelize.query(`ALTER TABLE channel_accounts ADD COLUMN ${columnName} ${definition}`)
    }
  }

  if (!await hasIndex(sequelize, 'channel_accounts', 'uk_channel_account_connection_external')) {
    await sequelize.query(
      'ALTER TABLE channel_accounts ADD UNIQUE INDEX uk_channel_account_connection_external (connection_id, external_account_id)'
    )
  }
}

module.exports = {
  ACCOUNT_COLUMNS,
  ensurePlatformConnectionsSchema
}
