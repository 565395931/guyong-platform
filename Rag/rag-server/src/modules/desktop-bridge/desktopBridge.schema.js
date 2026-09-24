const DESKTOP_BRIDGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS desktop_bridge_nodes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    node_key CHAR(36) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    machine_fingerprint_hash CHAR(64) NOT NULL,
    enrollment_token_hash CHAR(64) NOT NULL,
    agent_version VARCHAR(50) NULL,
    allowed_adapter_ids JSON NULL,
    capabilities JSON NULL,
    status ENUM('offline','online','degraded','disabled') NOT NULL DEFAULT 'offline',
    last_seen_at DATETIME(3) NULL,
    disabled_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_bridge_nodes_node_key (node_key),
    INDEX idx_bridge_nodes_status_seen (status, last_seen_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS desktop_bridge_pairings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code_hash CHAR(64) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    allowed_adapter_ids JSON NULL,
    expires_at DATETIME(3) NOT NULL,
    created_by BIGINT NULL,
    consumed_by_node_id BIGINT UNSIGNED NULL,
    consumed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_bridge_pairings_code_hash (code_hash),
    INDEX idx_bridge_pairings_expiry (expires_at, consumed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS desktop_bridge_bindings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    channel_account_id INT NOT NULL,
    preferred_node_id BIGINT UNSIGNED NULL,
    adapter_id VARCHAR(80) NOT NULL,
    mode ENUM('desktop_bridge','official_api','cloud_gateway') NOT NULL DEFAULT 'desktop_bridge',
    ai_mode VARCHAR(30) NOT NULL DEFAULT 'review',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_by BIGINT NULL,
    updated_by BIGINT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_bridge_bindings_account (channel_account_id),
    INDEX idx_bridge_bindings_node (preferred_node_id, enabled)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS desktop_bridge_leases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    channel_account_id INT NOT NULL,
    node_id BIGINT UNSIGNED NOT NULL,
    lease_token_hash CHAR(64) NOT NULL,
    generation BIGINT UNSIGNED NOT NULL DEFAULT 1,
    expires_at DATETIME(3) NOT NULL,
    heartbeat_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_bridge_leases_account (channel_account_id),
    INDEX idx_bridge_leases_node_expiry (node_id, expires_at),
    INDEX idx_bridge_leases_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS desktop_bridge_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id CHAR(36) NOT NULL,
    node_id BIGINT UNSIGNED NOT NULL,
    channel_account_id INT NULL,
    event_type VARCHAR(60) NOT NULL,
    payload JSON NULL,
    status ENUM('received','processing','processed','rejected','retryable_error') NOT NULL DEFAULT 'received',
    retry_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_code VARCHAR(80) NULL,
    error_message VARCHAR(500) NULL,
    occurred_at DATETIME(3) NULL,
    processed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_bridge_events_event_id (event_id),
    INDEX idx_bridge_events_status (status, created_at),
    INDEX idx_bridge_events_account (channel_account_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS desktop_bridge_commands (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    command_id CHAR(36) NOT NULL,
    local_message_id VARCHAR(36) NOT NULL,
    node_id BIGINT UNSIGNED NOT NULL,
    channel_account_id INT NOT NULL,
    payload JSON NOT NULL,
    state ENUM('queued','dispatching','accepted','succeeded','failed','expired') NOT NULL DEFAULT 'queued',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    deadline_at DATETIME(3) NOT NULL,
    accepted_at DATETIME(3) NULL,
    completed_at DATETIME(3) NULL,
    platform_message_id VARCHAR(255) NULL,
    error_code VARCHAR(80) NULL,
    error_message VARCHAR(500) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_bridge_commands_command_id (command_id),
    INDEX idx_bridge_commands_queue (state, deadline_at, created_at),
    INDEX idx_bridge_commands_node (node_id, state),
    INDEX idx_bridge_commands_message (local_message_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS desktop_bridge_audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    node_id BIGINT UNSIGNED NULL,
    channel_account_id INT NULL,
    actor_kind ENUM('user','node','system') NOT NULL,
    actor_id VARCHAR(80) NULL,
    action VARCHAR(80) NOT NULL,
    target_kind VARCHAR(50) NOT NULL,
    target_id VARCHAR(80) NULL,
    before_json JSON NULL,
    after_json JSON NULL,
    reason VARCHAR(500) NULL,
    correlation_id VARCHAR(80) NULL,
    outcome ENUM('success','failure') NOT NULL DEFAULT 'success',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_bridge_audit_node_created (node_id, created_at),
    INDEX idx_bridge_audit_account_created (channel_account_id, created_at),
    INDEX idx_bridge_audit_action_created (action, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

async function ensureDesktopBridgeSchema(sequelize) {
  for (const statement of DESKTOP_BRIDGE_SCHEMA_STATEMENTS) {
    await sequelize.query(statement)
  }
}

module.exports = { DESKTOP_BRIDGE_SCHEMA_STATEMENTS, ensureDesktopBridgeSchema }
