const VIDEO_DATA_SCHEMA = `CREATE TABLE IF NOT EXISTS video_account_data (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  data_date DATE NOT NULL COMMENT '数据日期',
  account_no VARCHAR(100) NOT NULL COMMENT '账号',
  platform VARCHAR(50) NOT NULL COMMENT '平台',
  play_count INT NOT NULL DEFAULT 0 COMMENT '播放量',
  like_count INT NOT NULL DEFAULT 0 COMMENT '点赞量',
  comment_count INT NOT NULL DEFAULT 0 COMMENT '评论数',
  inquiry_count INT NOT NULL DEFAULT 0 COMMENT '有效询盘',
  intent_customer_count INT NOT NULL DEFAULT 0 COMMENT '意向客户数',
  deal_count INT NOT NULL DEFAULT 0 COMMENT '成交数',
  remark VARCHAR(255) NULL COMMENT '备注',
  created_by INT NULL COMMENT '创建人',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_video_account_data_date (data_date, platform),
  INDEX idx_video_account_data_account (account_no),
  INDEX idx_video_account_data_platform (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

const VIDEO_DATA_SCHEMA_STATEMENTS = [VIDEO_DATA_SCHEMA]

async function ensureVideoDataSchema(sequelize) {
  for (const statement of VIDEO_DATA_SCHEMA_STATEMENTS) {
    await sequelize.query(statement)
  }
}

module.exports = {
  VIDEO_DATA_SCHEMA,
  VIDEO_DATA_SCHEMA_STATEMENTS,
  ensureVideoDataSchema
}

