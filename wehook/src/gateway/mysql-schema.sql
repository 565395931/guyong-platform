CREATE TABLE IF NOT EXISTS gateway_events (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(191) NOT NULL,
  protocol_version VARCHAR(32) NOT NULL,
  event_type VARCHAR(96) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  sent_at DATETIME(3) NOT NULL,
  payload_json LONGTEXT NOT NULL,
  delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  delivery_attempt INT UNSIGNED NOT NULL DEFAULT 0,
  last_attempt_at DATETIME(3) NULL,
  last_error VARCHAR(512) NULL,
  ack_status VARCHAR(32) NULL,
  ack_result_json LONGTEXT NULL,
  ack_at DATETIME(3) NULL,
  dead_letter_reason VARCHAR(512) NULL,
  dead_letter_at DATETIME(3) NULL,
  lease_owner VARCHAR(191) NULL,
  lease_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id),
  UNIQUE KEY uq_gateway_events_sequence (sequence),
  KEY idx_gateway_events_status_sequence (delivery_status, sequence),
  KEY idx_gateway_events_lease (delivery_status, lease_until),
  KEY idx_gateway_events_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gateway_delivery_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(191) NOT NULL,
  attempt INT UNSIGNED NOT NULL,
  replayed TINYINT(1) NOT NULL DEFAULT 0,
  client_id VARCHAR(191) NULL,
  error_message VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_gateway_attempts_event (event_id, attempt),
  CONSTRAINT fk_gateway_attempts_event FOREIGN KEY (event_id) REFERENCES gateway_events(event_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gateway_commands (
  command_id VARCHAR(191) NOT NULL,
  payload_json LONGTEXT NOT NULL,
  result_json LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gateway_dead_letters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(191) NOT NULL,
  event_type VARCHAR(96) NULL,
  sequence BIGINT UNSIGNED NULL,
  reason VARCHAR(512) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_gateway_dead_letters_event (event_id),
  KEY idx_gateway_dead_letters_sequence (sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gateway_meta (
  meta_key VARCHAR(64) NOT NULL,
  meta_value VARCHAR(255) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (meta_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
  version VARCHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO gateway_meta (meta_key, meta_value) VALUES ('cursor', '0') ON DUPLICATE KEY UPDATE meta_key = VALUES(meta_key);

INSERT IGNORE INTO gateway_schema_migrations (version) VALUES ('001_initial');
