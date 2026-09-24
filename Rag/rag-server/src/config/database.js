const { Sequelize } = require('sequelize')
const { ensureCommerceProjectionSchema } = require('@rag/commerce-projection-ledger')
const { NATIONALITY_SEEDS } = require('../modules/nationality/nationality.seed')
const { ensureCatalogSchema } = require('../modules/catalog/catalog.schema')
const { ensurePlatformConnectionsSchema } = require('../modules/platform-connections/platformConnections.schema')
const { ensureChannelEventInboxSchema } = require('../modules/channel-events/channelEventInbox.schema')
const { ensureChannelSyncStateSchema } = require('../modules/channel-sync/channelSyncState.schema')
const { ensureDesktopBridgeSchema } = require('../modules/desktop-bridge/desktopBridge.schema')
const { ensureCampaignSchema } = require('../modules/campaigns/campaign.schema')
const { ensureVideoDataSchema } = require('../modules/video-data/videoData.schema')
const { ensureWarehouseSchema } = require('../modules/warehouse/warehouse.schema')
const { ensurePlatformSkuMappingSchema } = require('../modules/platform-sku-mapping/platformSkuMapping.schema')
const { ensureOrderFulfillmentSchema } = require('../modules/order-fulfillment/orderFulfillment.schema')
const { seedDefaultChannelDefinitions } = require('../modules/channel-capabilities/channelDefinitions.seed')
const {
  resolveAdminSeedPassword,
  resolveDatabaseEnvironment
} = require('./databaseEnvironment')

// 从环境变量读取配置
const databaseEnvironment = resolveDatabaseEnvironment(process.env)
const adminSeedPassword = resolveAdminSeedPassword(process.env)
const DB_HOST = databaseEnvironment.host
const DB_PORT = databaseEnvironment.port
const DB_NAME = databaseEnvironment.name
const DB_USER = databaseEnvironment.user
const DB_PASSWORD = databaseEnvironment.password

// 先连接到 mysql 默认数据库，用于创建目标数据库
const sequelizeInit = new Sequelize('mysql', DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: 'mysql',
  timezone: '+00:00',
  logging: false,
  dialectOptions: {
    // 跨机器连接（部署机→开发机 Docker MySQL）需启用 TCP keepAlive，避免空闲长连接被 NAT/防火墙静默断开
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  }
})

// 创建 Sequelize 实例（连接目标数据库）
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: 'mysql',
  logging: false, // 生产环境可改为 false
  timezone: '+00:00',
  pool: {
    max: 10,
    min: 0,
    acquire: 10000, // 从 30000 缩短到 10s，避免前端超时前接口一直挂起
    idle: 5000, // 空闲 5s 即回收，避免复用被中间网络断开的长连接
    evict: 10000 // 定期驱逐，配合检测死连接
  },
  dialectOptions: {
    // 跨机器连接需启用 TCP keepAlive，防止长连接被 NAT/防火墙静默断开导致 ETIMEDOUT
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  },
  define: {
    timestamps: true, // 自动添加 createdAt 和 updatedAt
    underscored: true, // 使用下划线命名
    freezeTableName: true // 表名不自动转复数
  }
})

// 连接数据库
const connectDB = async () => {
  try {
    // 先尝试连接目标数据库
    await sequelize.authenticate()
    console.log(`MySQL 连接成功: ${DB_HOST}:${DB_PORT}/${DB_NAME}`)
  } catch (error) {
    // 如果数据库不存在，先创建
    if (error.message.includes('Unknown database')) {
      console.log(`数据库 ${DB_NAME} 不存在，正在创建...`)
      try {
        // 连接到 mysql 默认数据库
        await sequelizeInit.authenticate()
        // 创建目标数据库
        await sequelizeInit.query(`CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
        console.log(`数据库 ${DB_NAME} 创建成功`)
        await sequelizeInit.close()
        // 重新连接目标数据库
        await sequelize.authenticate()
        console.log(`MySQL 连接成功: ${DB_HOST}:${DB_PORT}/${DB_NAME}`)
      } catch (createError) {
        console.error(`创建数据库失败: ${createError.message}`)
        process.exit(1)
      }
    } else {
      console.error(`MySQL 连接失败: ${error.message}`)
      process.exit(1)
    }
  }

  // 同步模型到数据库（创建表）
  try {
    // 使用 force: false 避免累积过多索引
    // alter: true 可能导致索引重复创建，超出 MySQL 64 索引限制
    await sequelize.sync({ force: false })
    console.log('数据库表同步完成')
    await ensureCatalogSchema(sequelize)
    console.log('产品与报价目录表初始化完成')
    await ensurePlatformConnectionsSchema(sequelize)
    console.log('企业平台连接表初始化完成')
    await ensureChannelEventInboxSchema(sequelize)
    console.log('渠道事件收件箱初始化完成')
    await ensureCommerceProjectionSchema(sequelize)
    console.log('订单投影账本初始化完成')
    await ensureDesktopBridgeSchema(sequelize)
    await ensureCampaignSchema(sequelize)
    await ensureVideoDataSchema(sequelize)
    await ensureWarehouseSchema(sequelize)
    await ensurePlatformSkuMappingSchema(sequelize)
    await ensureOrderFulfillmentSchema(sequelize)
    console.log('campaign tasks table ready')
    console.log('桌面桥接状态表初始化完成')

    // ---- 迁移：添加 HITL 相关字段 ----
    try {
      await sequelize.query(
        `ALTER TABLE runs MODIFY COLUMN status ENUM('running','completed','error','cancelled','awaiting_approval') DEFAULT 'running' COMMENT '执行状态'`
      )
      console.log('runs.status ENUM 迁移完成')
    } catch (alterError) {
      // 如果列已存在或语法差异，忽略
      console.log('runs.status 迁移跳过:', alterError.message.split('\n')[0])
    }

    try {
      await sequelize.query(
        `ALTER TABLE runs ADD COLUMN interrupt_data TEXT COMMENT 'HITL中断数据'`
      )
      console.log('runs.interrupt_data 列添加完成')
    } catch (addColError) {
      // 如果列已存在，忽略
      console.log('runs.interrupt_data 已存在，跳过')
    }

    // ---- 迁移：User 表扩展字段 ----
    try {
      await sequelize.query(`ALTER TABLE users ADD COLUMN skills JSON COMMENT '技能标签（坐席专用）'`)
      console.log('users.skills 列添加完成')
    } catch (e) {
      console.log('users.skills 已存在，跳过')
    }
    try {
      await sequelize.query(`ALTER TABLE users ADD COLUMN max_concurrent INT DEFAULT 5 COMMENT '最大并发接待数（坐席专用）'`)
      console.log('users.max_concurrent 列添加完成')
    } catch (e) {
      console.log('users.max_concurrent 已存在，跳过')
    }
    // 迁移 role 字段为 ENUM
    try {
      await sequelize.query(`ALTER TABLE users MODIFY COLUMN role ENUM('user','agent','supervisor','admin') DEFAULT 'user' COMMENT '角色（user/agent/supervisor/admin）'`)
      console.log('users.role ENUM 迁移完成')
    } catch (e) {
      console.log('users.role 迁移跳过:', e.message.split('\n')[0])
    }

    // ---- 迁移：坐席技能标签字典表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS seat_skill_tags (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(50) NOT NULL UNIQUE COMMENT '技能标签名称',
          sort_order INT DEFAULT 0 COMMENT '排序值',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='坐席技能标签字典表'
      `)
      await sequelize.query(`
        INSERT IGNORE INTO seat_skill_tags (name, sort_order) VALUES
          ('英文', 10),
          ('销售', 20),
          ('售后', 30),
          ('技术支持', 40)
      `)
      console.log('seat_skill_tags 表初始化完成')
    } catch (e) {
      console.log('seat_skill_tags 初始化跳过:', e.message.split('\n')[0])
    }

    // ---- 迁移：channel_accounts 表扩展字段（WhatsApp 账号信息）----
    try {
      await sequelize.query(`ALTER TABLE channel_accounts ADD COLUMN phone_number VARCHAR(30) NULL COMMENT 'WhatsApp 手机号（扫码绑定后自动填充）'`)
      console.log('channel_accounts.phone_number 列添加完成')
    } catch (e) {
      console.log('channel_accounts.phone_number 已存在，跳过')
    }
    try {
      await sequelize.query(`ALTER TABLE channel_accounts ADD COLUMN whatsapp_name VARCHAR(100) NULL COMMENT 'WhatsApp 显示名称（扫码绑定后自动填充）'`)
      console.log('channel_accounts.whatsapp_name 列添加完成')
    } catch (e) {
      console.log('channel_accounts.whatsapp_name 已存在，跳过')
    }

    // ---- 迁移：坐席账号绑定表 ----
    try {
      await sequelize.query(`ALTER TABLE channel_accounts ADD COLUMN knowledge_scope VARCHAR(20) NULL COMMENT '默认知识范围：common/overseas/domestic/channel' AFTER whatsapp_name`)
      console.log('channel_accounts.knowledge_scope 字段已添加')
    } catch (e) {
      console.log('channel_accounts.knowledge_scope 字段已存在，跳过')
    }
    try {
      await sequelize.query(`ALTER TABLE channel_accounts ADD COLUMN knowledge_channels JSON NULL COMMENT '默认适用渠道：all/whatsapp/wechat/douyin' AFTER knowledge_scope`)
      console.log('channel_accounts.knowledge_channels 字段已添加')
    } catch (e) {
      console.log('channel_accounts.knowledge_channels 字段已存在，跳过')
    }
    try {
      await sequelize.query(`
        UPDATE channel_accounts
        SET knowledge_scope = CASE
              WHEN channel = 'whatsapp' THEN 'overseas'
              WHEN channel IN ('wechat', 'douyin') THEN 'domestic'
              ELSE 'common'
            END,
            knowledge_channels = JSON_ARRAY('all')
        WHERE knowledge_scope IS NULL OR knowledge_scope = ''
      `)
      console.log('channel_accounts 默认知识范围已补齐')
    } catch (e) {
      console.log('channel_accounts 默认知识范围补齐跳过:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS channel_definitions (
          code VARCHAR(30) PRIMARY KEY COMMENT '渠道编码，如 whatsapp/wechat/douyin',
          label VARCHAR(80) NOT NULL COMMENT '渠道显示名称',
          adapter_type VARCHAR(30) DEFAULT 'manual' COMMENT '默认适配器类型：waha/manual 等',
          knowledge_scope VARCHAR(20) DEFAULT 'common' COMMENT '默认知识范围：common/overseas/domestic/channel',
          knowledge_channels JSON NULL COMMENT '默认适用渠道',
          sort_order INT DEFAULT 0 COMMENT '排序',
          status ENUM('active','inactive') DEFAULT 'active' COMMENT '状态',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_status_sort (status, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='渠道定义字典表'
      `)
      console.log('channel_definitions 表创建完成')
    } catch (e) {
      console.log('channel_definitions 表已存在，跳过')
    }
    try {
      await seedDefaultChannelDefinitions(sequelize)
    } catch (e) {
      console.log('channel_definitions 默认渠道初始化跳过:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS seat_account_bindings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          seat_id INT NOT NULL COMMENT '坐席用户 ID（关联 users 表）',
          account_id INT NOT NULL COMMENT '渠道账号 ID（关联 channel_accounts 表）',
          channel VARCHAR(30) NOT NULL COMMENT '渠道标识：whatsapp / douyin / wechat 等',
          status ENUM('active','inactive') DEFAULT 'active' COMMENT '绑定状态',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_account_status (account_id, status),
          INDEX idx_seat_status (seat_id, status),
          INDEX idx_seat_channel_status (seat_id, channel, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='坐席账号绑定关系表'
      `)
      console.log('seat_account_bindings 表创建完成')
    } catch (e) {
      console.log('seat_account_bindings 表已存在，跳过')
    }

    // ---- 迁移：国籍字典表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS nationality_dictionary (
          country_code CHAR(2) PRIMARY KEY COMMENT 'ISO 3166-1 alpha-2 国家代码',
          name_zh VARCHAR(100) NOT NULL COMMENT '中文名称',
          name_en VARCHAR(100) NOT NULL COMMENT '英文名称',
          phone_prefixes JSON NULL COMMENT '国际电话前缀数组，不包含加号',
          language_codes JSON NULL COMMENT '常用 ISO 639-1 语言代码数组',
          inference_priority INT DEFAULT 0 COMMENT '语言存在多国候选时的推测优先级',
          sort_order INT DEFAULT 0 COMMENT '字典显示顺序',
          status ENUM('active','inactive') DEFAULT 'active' COMMENT '字典状态',
          seed_version INT DEFAULT 2 COMMENT '系统种子版本，数据库人工维护后不重复覆盖',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_nationality_status_sort (status, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话国籍推测字典'
      `)

      try {
        await sequelize.query(`ALTER TABLE nationality_dictionary ADD COLUMN seed_version INT DEFAULT 1 COMMENT '系统种子版本，数据库人工维护后不重复覆盖' AFTER status`)
      } catch {
        // Existing v2 schema already has the seed version column.
      }

      const values = []
      const replacements = {}
      NATIONALITY_SEEDS.forEach((item, index) => {
        const [code, nameZh, nameEn, phonePrefixes, languageCodes, priority] = item
        values.push(`(:code${index}, :nameZh${index}, :nameEn${index}, :phonePrefixes${index}, :languageCodes${index}, :priority${index}, :sort${index}, 'active', NOW(), NOW())`)
        replacements[`code${index}`] = code
        replacements[`nameZh${index}`] = nameZh
        replacements[`nameEn${index}`] = nameEn
        replacements[`phonePrefixes${index}`] = JSON.stringify(phonePrefixes)
        replacements[`languageCodes${index}`] = JSON.stringify(languageCodes)
        replacements[`priority${index}`] = priority
        replacements[`sort${index}`] = (index + 1) * 10
      })
      await sequelize.query(
        `INSERT INTO nationality_dictionary
           (country_code, name_zh, name_en, phone_prefixes, language_codes,
            inference_priority, sort_order, status, created_at, updated_at)
         VALUES ${values.join(', ')}
         ON DUPLICATE KEY UPDATE
           name_zh = IF(COALESCE(seed_version, 0) < 2, VALUES(name_zh), name_zh),
           name_en = IF(COALESCE(seed_version, 0) < 2, VALUES(name_en), name_en),
           phone_prefixes = IF(COALESCE(seed_version, 0) < 2, VALUES(phone_prefixes), phone_prefixes),
           language_codes = IF(COALESCE(seed_version, 0) < 2, VALUES(language_codes), language_codes),
           inference_priority = IF(COALESCE(seed_version, 0) < 2, VALUES(inference_priority), inference_priority),
           sort_order = IF(COALESCE(seed_version, 0) < 2, VALUES(sort_order), sort_order),
           seed_version = GREATEST(COALESCE(seed_version, 0), 2),
           updated_at = NOW()`,
        { replacements }
      )
      console.log('nationality_dictionary 表初始化完成')
    } catch (e) {
      console.log('nationality_dictionary 初始化跳过:', e.message.split('\n')[0])
    }

    // ---- 迁移：聚合平台会话表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id VARCHAR(36) PRIMARY KEY COMMENT '会话 UUID',
          channel VARCHAR(30) NOT NULL COMMENT '渠道标识：whatsapp / douyin / wechat',
          account_id INT NULL COMMENT '渠道账号 ID（关联 channel_accounts 表）',
          user_id VARCHAR(100) NULL COMMENT '外部用户标识（渠道中的联系人 ID/手机号）',
          user_name VARCHAR(100) NULL COMMENT '外部用户显示名称',
          nationality_code CHAR(2) NULL COMMENT '国籍字典代码',
          nationality_source VARCHAR(20) NULL COMMENT '国籍来源：phone/language/manual',
          nationality_inferred_at DATETIME NULL COMMENT '国籍推测或编辑时间',
          agent_id INT NULL COMMENT '分配的坐席 ID（关联 users 表，兼容旧字段）',
          pool_type VARCHAR(20) DEFAULT 'ai_self' COMMENT '池类型：ai_self(自助) / pending_human(待人工) / public(公共) / private(私有) / long_term(长期跟进)',
          conv_status VARCHAR(20) DEFAULT 'ai_serving' COMMENT '会话状态：ai_serving / pending_claim / handling / following / archived',
          claimed_by INT NULL COMMENT '当前认领坐席 ID',
          claimed_at DATETIME NULL COMMENT '认领时间',
          priority INT DEFAULT 0 COMMENT '优先级（0普通 / 1紧急 / 2加急）',
          last_reply_by VARCHAR(20) NULL COMMENT '最后回复方：ai / customer / agent',
          last_reply_time DATETIME NULL COMMENT '最后回复时间',
          last_message TEXT NULL COMMENT '最后消息摘要',
          last_message_time DATETIME NULL COMMENT '最后消息时间',
          unread_count INT DEFAULT 0 COMMENT '未读消息数',
          status VARCHAR(20) DEFAULT 'open' COMMENT '旧状态字段（兼容）：open / closed',
          follow_up_reminder_at DATETIME NULL COMMENT '长期跟进提醒时间',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_channel (channel),
          INDEX idx_agent_id (agent_id),
          INDEX idx_user_id (user_id),
          INDEX idx_last_message_time (last_message_time),
          INDEX idx_account_id (account_id),
          INDEX idx_nationality_code (nationality_code),
          INDEX idx_pool_type (pool_type),
          INDEX idx_conv_status (conv_status),
          INDEX idx_claimed_by (claimed_by)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聚合平台会话表'
      `)
      console.log('conversations 表创建完成')
    } catch (e) {
      console.log('conversations 表已存在，跳过')
    }

    // ---- 迁移：conversations 表新增会话池字段（对已有表增量添加）----
    const convNewColumns = [
      { col: 'pool_type', def: "VARCHAR(20) DEFAULT 'ai_self' COMMENT '池类型：ai_self / pending_human / public / private / long_term'" },
      { col: 'conv_status', def: "VARCHAR(20) DEFAULT 'ai_serving' COMMENT '会话状态：ai_serving / pending_claim / handling / following / archived'" },
      { col: 'claimed_by', def: 'INT NULL COMMENT "当前认领坐席 ID"' },
      { col: 'claimed_at', def: 'DATETIME NULL COMMENT "认领时间"' },
      { col: 'priority', def: 'INT DEFAULT 0 COMMENT "优先级（0普通/1紧急/2加急）"' },
      { col: 'last_reply_by', def: "VARCHAR(20) NULL COMMENT '最后回复方：ai / customer / agent'" },
      { col: 'last_reply_time', def: 'DATETIME NULL COMMENT "最后回复时间"' },
      { col: 'follow_up_reminder_at', def: 'DATETIME NULL COMMENT "长期跟进提醒时间"' },
      { col: 'user_avatar', def: "VARCHAR(500) NULL COMMENT '用户头像本地路径（如 /api/avatars/xxx.jpg）'" },
      { col: 'nationality_code', def: "CHAR(2) NULL COMMENT '国籍字典代码'" },
      { col: 'nationality_source', def: "VARCHAR(20) NULL COMMENT '国籍来源：phone/language/manual'" },
      { col: 'nationality_inferred_at', def: 'DATETIME NULL COMMENT "国籍推测或编辑时间"' }
    ]
    for (const { col, def } of convNewColumns) {
      try {
        await sequelize.query(`ALTER TABLE conversations ADD COLUMN ${col} ${def}`)
        console.log(`conversations.${col} 列添加完成`)
      } catch (e) {
        // 列已存在，忽略
      }
    }
    // 新增索引
    const convNewIndexes = [
      { name: 'idx_pool_type', sql: 'ALTER TABLE conversations ADD INDEX idx_pool_type (pool_type)' },
      { name: 'idx_conv_status', sql: 'ALTER TABLE conversations ADD INDEX idx_conv_status (conv_status)' },
      { name: 'idx_claimed_by', sql: 'ALTER TABLE conversations ADD INDEX idx_claimed_by (claimed_by)' },
      { name: 'idx_nationality_code', sql: 'ALTER TABLE conversations ADD INDEX idx_nationality_code (nationality_code)' }
    ]
    for (const { name, sql } of convNewIndexes) {
      try {
        await sequelize.query(sql)
        console.log(`conversations 索引 ${name} 添加完成`)
      } catch (e) {
        // 索引已存在，忽略
      }
    }

    // ---- 迁移：会话池操作日志表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS conversation_pool_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          conversation_id VARCHAR(36) NOT NULL COMMENT '会话 ID',
          action VARCHAR(30) NOT NULL COMMENT '操作类型：pool_change / claim / release / mark_long_term / archive / transfer / ai_to_human',
          from_pool VARCHAR(20) NULL COMMENT '原池类型',
          to_pool VARCHAR(20) NULL COMMENT '目标池类型',
          operator_id INT NULL COMMENT '操作人 ID（坐席/管理员）',
          operator_name VARCHAR(50) NULL COMMENT '操作人名称',
          operator_type VARCHAR(10) NULL COMMENT '操作者类型：agent / ai / system / admin',
          reason VARCHAR(200) NULL COMMENT '操作原因',
          extra JSON NULL COMMENT '附加信息',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_conversation_id (conversation_id),
          INDEX idx_action (action),
          INDEX idx_operator_id (operator_id),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话池操作日志表'
      `)
      console.log('conversation_pool_logs 表创建完成')
    } catch (e) {
      console.log('conversation_pool_logs 表已存在，跳过')
    }

    // ---- 迁移：会话池配置表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS conversation_pool_config (
          id INT AUTO_INCREMENT PRIMARY KEY,
          config_key VARCHAR(50) NOT NULL UNIQUE COMMENT '配置键名',
          config_value JSON NULL COMMENT '配置值（JSON）',
          description VARCHAR(200) NULL COMMENT '配置说明',
          updated_by INT NULL COMMENT '最后更新人 ID',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话池配置表'
      `)
      console.log('conversation_pool_config 表创建完成')
    } catch (e) {
      console.log('conversation_pool_config 表已存在，跳过')
    }

    // ---- 迁移：坐席在线状态表 ----
    // ---- Migration: inbound message review queue ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS message_review_items (
          id CHAR(36) PRIMARY KEY,
          conversation_id VARCHAR(36) NOT NULL,
          primary_message_id VARCHAR(36) NOT NULL,
          message_ids JSON NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          risk_level VARCHAR(10) NOT NULL,
          confidence DECIMAL(6,5) NULL,
          reason_code VARCHAR(40) NOT NULL,
          reason_text VARCHAR(500) NOT NULL DEFAULT '',
          recommended_action VARCHAR(20) NOT NULL DEFAULT 'review',
          rule_hits JSON NOT NULL,
          model_name VARCHAR(100) NULL,
          assigned_to INT NULL,
          claimed_by INT NULL,
          claimed_at DATETIME NULL,
          resolved_by INT NULL,
          resolution_reason VARCHAR(100) NULL,
          outbound_message_id VARCHAR(36) NULL,
          resolved_at DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_review_primary_message (primary_message_id),
          INDEX idx_review_assignee (status, assigned_to, created_at),
          INDEX idx_review_risk (status, risk_level, created_at),
          INDEX idx_review_conversation (conversation_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      console.log('message_review_items table ready')
    } catch (e) {
      console.log('message_review_items migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS seat_status (
          user_id INT PRIMARY KEY COMMENT '坐席用户 ID',
          status VARCHAR(20) DEFAULT 'offline' COMMENT '在线状态：online / offline / away / busy',
          last_active_at DATETIME NULL COMMENT '最后活跃时间',
          current_load INT DEFAULT 0 COMMENT '当前并发接待数',
          max_concurrent INT DEFAULT 5 COMMENT '最大并发接待数',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='坐席在线状态表'
      `)
      console.log('seat_status 表创建完成')
    } catch (e) {
      console.log('seat_status 表已存在，跳过')
    }

    // ---- 初始化池配置默认值 ----
    try {
      const [configRows] = await sequelize.query("SELECT id FROM conversation_pool_config LIMIT 1")
      if (configRows.length === 0) {
        await sequelize.query(`
          INSERT INTO conversation_pool_config (config_key, config_value, description) VALUES
          ('ai_self_pool_enabled', 'true', 'AI自助池总开关，控制新会话是否默认进入AI自助池并由AI自动回复'),
          ('ai_transfer_keywords', '["转人工","人工客服","找人工","人工","转接人工","我要人工"]', '客户主动转人工关键词列表；后台维护中文关键词，运行时支持多语言匹配'),
          ('ai_max_rounds', '0', 'AI自助池最大回复轮数，超过后自动转待人工池（0=不限制）'),
          ('ai_no_reply_timeout', '1800', 'AI自助池客户无回复超时秒数，超时转公共池暂存（默认1800=30分钟）'),
          ('ai_confidence_threshold', '0.7', 'RAG检索置信度阈值，低于此值自动转待人工池'),
          ('complexity_check_enabled', 'true', '是否启用LLM复杂度判断（新客户消息是否需要人工）'),
          ('sentiment_check_enabled', 'true', '是否启用客户情绪分析（负面情绪触发转人工）'),
          ('pending_human_aging_timeout_enabled', 'true', '待人工池超龄转公共池开关，关闭后不再自动降级到公共池'),
          ('pending_human_aging_timeout', '600', '待人工池超龄秒数，超时无人抢单转公共池'),
          ('public_pool_archive_timeout', '86400', '公共池超龄秒数，超时自动归档（客户流失）'),
          ('seat_offline_release', 'true', '坐席离线时是否自动释放私有池会话'),
          ('private_pool_stale_timeout_enabled', 'true', '私有池消息停滞超时释放开关，关闭后不再因最后消息停滞自动释放到公共池'),
          ('long_term_reminder_hours', '48', '长期跟进池提醒间隔小时数')
        `)
        console.log('会话池配置默认值已初始化')
      }
    } catch (e) {
      console.log('池配置初始化跳过:', e.message.split('\n')[0])
    }

    // ---- 迁移：增量插入 ai_self_pool_enabled 配置项（已有数据库补丁）----
    try {
      await sequelize.query(
        `INSERT INTO conversation_pool_config (config_key, config_value, description)
         SELECT 'ai_self_pool_enabled', 'true', 'AI自助池总开关，控制新会话是否默认进入AI自助池并由AI自动回复'
         WHERE NOT EXISTS (SELECT 1 FROM conversation_pool_config WHERE config_key = 'ai_self_pool_enabled')`
      )
      console.log('ai_self_pool_enabled 配置项已确认')
    } catch (e) {
      // 忽略
    }

    // ---- 迁移：增量插入新增运营配置项（Redis + 队列化改造）----
    const newConfigItems = [
      { key: 'ai_no_reply_timeout_enabled', value: 'true', desc: 'AI自助池无回复超时流转开关，关闭后不再因客户未回复自动转公共池' },
      { key: 'ai_no_reply_timeout', value: '1800', desc: 'AI自助池客户无回复超时秒数，超时转公共池暂存（默认1800=30分钟）' },
      { key: 'pending_human_aging_timeout_enabled', value: 'true', desc: '待人工池超龄转公共池开关，关闭后不再自动降级到公共池' },
      { key: 'ai_queue_concurrency', value: '5', desc: 'AI回复队列并发处理数（同时处理的AI任务数）' },
      { key: 'ai_retry_limit', value: '3', desc: 'AI回复失败重试次数（超过后自动转人工）' },
      { key: 'ai_timeout_ms', value: '30000', desc: 'AI回复单次调用超时毫秒数' },
      { key: 'seat_max_concurrent', value: '5', desc: '坐席最大并发接待会话数（0=使用users表max_concurrent字段）' },
      { key: 'ai_self_stale_timeout', value: '1800', desc: '客户等待 AI 回复超时秒数，超过后转待人工池（默认1800=30分钟）' },
      { key: 'private_pool_stale_timeout_enabled', value: 'true', desc: '私有池消息停滞超时释放开关，关闭后不再因最后消息停滞自动释放到公共池' },
      { key: 'private_pool_stale_timeout', value: '3600', desc: '私有池最后消息超时秒数，超过后自动释放到公共池（默认3600=1小时）' },
      { key: 'translation_context_message_count', value: '3', desc: '翻译时附带的最近消息条数（0=关闭上下文翻译，仅翻译单条消息）' },
      { key: 'rag_context_message_count', value: '0', desc: 'RAG检索时附带的最近消息条数（0=智能检测，仅短消息/代词时拼接；>0=总是拼接N条）' },
      { key: 'llm_context_message_count', value: '20', desc: 'AI推荐/自助回复时传给LLM的会话历史消息条数' },
      { key: 'message_review_enabled', value: 'true', desc: 'Enable inbound message review' },
      { key: 'message_review_model', value: '"deepseek-v4-flash"', desc: 'Inbound message review model' },
      { key: 'message_review_allow_threshold', value: '0.85', desc: 'Minimum confidence for automatic pass-through' },
      { key: 'message_review_context_count', value: '6', desc: 'Conversation context messages sent to the reviewer' },
      { key: 'message_review_timeout_ms', value: '12000', desc: 'Message review model timeout in milliseconds' },
      { key: 'message_review_merge_window_seconds', value: '30', desc: 'Pending message coalescing window in seconds' },
      { key: 'message_review_assignment_timeout_seconds', value: '300', desc: 'Owner assignment fallback timeout in seconds' }
    ]
    for (const item of newConfigItems) {
      try {
        await sequelize.query(
          `INSERT INTO conversation_pool_config (config_key, config_value, description)
           SELECT :key, :value, :desc
           WHERE NOT EXISTS (SELECT 1 FROM conversation_pool_config WHERE config_key = :key)`,
          { replacements: { key: item.key, value: item.value, desc: item.desc } }
        )
      } catch (e) {
        // 忽略已存在
      }
    }
    console.log('新增运营配置项已确认')

    // ---- 迁移：AI 自助池无回复超时旧默认值 5 分钟 -> 30 分钟 ----
    try {
      await sequelize.query(
        `UPDATE conversation_pool_config
         SET config_value = :value,
             description = :desc,
             updated_at = NOW()
         WHERE config_key = 'ai_no_reply_timeout'
           AND JSON_UNQUOTE(config_value) = '300'
           AND updated_by IS NULL`,
        {
          replacements: {
            value: '1800',
            desc: 'AI自助池客户无回复超时秒数，超时转公共池暂存（默认1800=30分钟）'
          }
        }
      )
      console.log('ai_no_reply_timeout 旧默认值已确认')
    } catch (e) {
      console.log('ai_no_reply_timeout 旧默认值迁移跳过:', e.message.split('\n')[0])
    }

    // ---- 迁移：媒体文件表（用于 WhatsApp 图片/视频/文件发送）----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS media_files (
          id VARCHAR(36) PRIMARY KEY COMMENT '文件 UUID',
          original_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
          display_name VARCHAR(255) NULL COMMENT '展示文件名，可在后台修改',
          description TEXT NULL COMMENT '文件描述',
          filename VARCHAR(255) NOT NULL COMMENT '存储文件名',
          media_type VARCHAR(20) NOT NULL COMMENT '媒体类型：image / video / file',
          mime_type VARCHAR(100) NULL COMMENT 'MIME 类型',
          size BIGINT DEFAULT 0 COMMENT '文件大小（字节）',
          storage_path VARCHAR(500) NOT NULL COMMENT '本地存储路径',
          url VARCHAR(500) NOT NULL COMMENT '对外访问路径',
          uploader_id INT NULL COMMENT '上传人 ID',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_media_type (media_type),
          INDEX idx_created_at (created_at),
          INDEX idx_uploader_id (uploader_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='可发送媒体文件表'
      `)
      console.log('media_files 表创建完成')
    } catch (e) {
      console.log('media_files 表已存在，跳过')
    }
    try {
      await sequelize.query(`ALTER TABLE media_files ADD COLUMN display_name VARCHAR(255) NULL COMMENT '展示文件名，可在后台修改' AFTER original_name`)
      console.log('media_files.display_name 列添加完成')
    } catch (e) {
      // 字段已存在，忽略
    }
    try {
      await sequelize.query(`ALTER TABLE media_files ADD COLUMN description TEXT NULL COMMENT '文件描述' AFTER display_name`)
      console.log('media_files.description 列添加完成')
    } catch (e) {
      // 字段已存在，忽略
    }

    // ---- Migration: order domain tables ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Order UUID',
          order_no VARCHAR(40) NOT NULL UNIQUE COMMENT 'Business order number',
          source_conversation_id VARCHAR(36) NULL COMMENT 'Source conversation id',
          channel VARCHAR(30) NULL COMMENT 'Source channel',
          account_id INT NULL COMMENT 'Channel account id',
          channel_user_id VARCHAR(100) NULL COMMENT 'External customer id',
          customer_name VARCHAR(120) NULL COMMENT 'Customer name',
          customer_phone VARCHAR(60) NULL COMMENT 'Customer phone',
          customer_email VARCHAR(120) NULL COMMENT 'Customer email',
          customer_country VARCHAR(100) NULL COMMENT 'Customer country',
          customer_city VARCHAR(100) NULL COMMENT 'Customer city',
          customer_address TEXT NULL COMMENT 'Customer address',
          owner_seat_id INT NULL COMMENT 'Owner seat id',
          owner_name VARCHAR(80) NULL COMMENT 'Owner seat name',
          status VARCHAR(30) DEFAULT 'draft' COMMENT 'draft/confirmed/paid/purchasing/domestic_shipping/international_shipping/delivered/after_sales/closed/cancelled',
          payment_status VARCHAR(30) DEFAULT 'unpaid' COMMENT 'unpaid/partial/paid/refunded',
          payment_platform VARCHAR(80) NULL COMMENT 'Payment platform',
          production_batch VARCHAR(120) NULL COMMENT 'Production batch',
          currency VARCHAR(10) DEFAULT 'USD' COMMENT 'Settlement currency',
          goods_amount DECIMAL(12,2) NULL COMMENT 'Goods amount',
          shipping_amount DECIMAL(12,2) NULL COMMENT 'Shipping charged to customer',
          deal_amount DECIMAL(12,2) NULL COMMENT 'Final deal amount',
          cost_amount DECIMAL(12,2) NULL COMMENT 'Goods cost',
          freight_fee_rmb DECIMAL(12,2) NULL COMMENT 'Freight cost in RMB',
          marketing_amount DECIMAL(12,2) NULL COMMENT 'Gross marketing amount',
          purchase_time DATETIME NULL COMMENT 'Purchase time',
          paid_at DATETIME NULL COMMENT 'Paid time',
          closed_at DATETIME NULL COMMENT 'Closed time',
          notes TEXT NULL COMMENT 'Order notes',
          raw_payload JSON NULL COMMENT 'Raw extracted or imported payload',
          created_by INT NULL COMMENT 'Created by user id',
          updated_by INT NULL COMMENT 'Updated by user id',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_source_conversation_id (source_conversation_id),
          INDEX idx_channel_account (channel, account_id),
          INDEX idx_channel_user_id (channel_user_id),
          INDEX idx_owner_status (owner_seat_id, status),
          INDEX idx_status_purchase_time (status, purchase_time),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order records'
      `)
      console.log('orders table ready')
    } catch (e) {
      console.log('orders table migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`ALTER TABLE orders ADD COLUMN production_batch VARCHAR(120) NULL COMMENT 'Production batch' AFTER payment_platform`)
      console.log('orders.production_batch column added')
    } catch (e) {
      console.log('orders.production_batch column exists, skipped')
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS order_items (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Order item UUID',
          order_id VARCHAR(36) NOT NULL COMMENT 'Order id',
          external_sku VARCHAR(191) NULL COMMENT 'Platform SKU',
          sku_code VARCHAR(100) NULL COMMENT 'Canonical warehouse SKU',
          product_name VARCHAR(255) NOT NULL COMMENT 'Product name',
          specification VARCHAR(255) NULL COMMENT 'Product specification',
          description TEXT NULL COMMENT 'Invoice description',
          quantity DECIMAL(12,3) DEFAULT 1 COMMENT 'Quantity',
          unit_price DECIMAL(12,2) NULL COMMENT 'Unit price',
          currency VARCHAR(10) DEFAULT 'USD' COMMENT 'Currency',
          total_amount DECIMAL(12,2) NULL COMMENT 'Line total',
          sort_order INT DEFAULT 0 COMMENT 'Sort order',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_order_id (order_id),
          INDEX idx_sort (order_id, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order items'
      `)
      console.log('order_items table ready')
    } catch (e) {
      console.log('order_items table migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`ALTER TABLE order_items ADD COLUMN external_sku VARCHAR(191) NULL COMMENT 'Platform SKU' AFTER order_id`)
    } catch (e) {
      // Existing installations already have the column.
    }
    try {
      await sequelize.query(`ALTER TABLE order_items ADD COLUMN sku_code VARCHAR(100) NULL COMMENT 'Canonical warehouse SKU' AFTER external_sku`)
    } catch (e) {
      // Existing installations already have the column.
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS order_shipments (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Shipment UUID',
          order_id VARCHAR(36) NOT NULL COMMENT 'Order id',
          shipment_type VARCHAR(30) DEFAULT 'international' COMMENT 'domestic/international/other',
          courier VARCHAR(120) NULL COMMENT 'Courier name',
          tracking_no VARCHAR(160) NULL COMMENT 'Tracking number',
          status VARCHAR(30) DEFAULT 'pending' COMMENT 'pending/shipped/in_transit/delivered/exception',
          expected_arrival_at DATETIME NULL COMMENT 'Expected arrival time',
          shipped_at DATETIME NULL COMMENT 'Shipped time',
          arrived_at DATETIME NULL COMMENT 'Arrived time',
          recipient_name VARCHAR(120) NULL COMMENT 'Recipient name',
          recipient_phone VARCHAR(80) NULL COMMENT 'Recipient phone',
          country VARCHAR(100) NULL COMMENT 'Country',
          city VARCHAR(100) NULL COMMENT 'City',
          address_line1 VARCHAR(255) NULL COMMENT 'Address line',
          address_detail TEXT NULL COMMENT 'Detailed address',
          freight_fee DECIMAL(12,2) NULL COMMENT 'Freight fee',
          metadata JSON NULL COMMENT 'Provider payload',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_order_id (order_id),
          INDEX idx_tracking_no (tracking_no),
          INDEX idx_status_expected (status, expected_arrival_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order shipments'
      `)
      console.log('order_shipments table ready')
    } catch (e) {
      console.log('order_shipments table migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS order_events (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Order event UUID',
          order_id VARCHAR(36) NOT NULL COMMENT 'Order id',
          event_type VARCHAR(50) NOT NULL COMMENT 'Event type',
          title VARCHAR(160) NULL COMMENT 'Event title',
          description TEXT NULL COMMENT 'Event description',
          operator_id INT NULL COMMENT 'Operator id',
          operator_name VARCHAR(80) NULL COMMENT 'Operator name',
          payload JSON NULL COMMENT 'Event payload',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_order_id (order_id),
          INDEX idx_event_type (event_type),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order event timeline'
      `)
      console.log('order_events table ready')
    } catch (e) {
      console.log('order_events table migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS invoice_counters (
          counter_date DATE PRIMARY KEY COMMENT 'Invoice date',
          seq INT DEFAULT 0 COMMENT 'Daily sequence',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Invoice daily counters'
      `)
      console.log('invoice_counters table ready')
    } catch (e) {
      console.log('invoice_counters table migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS order_invoices (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Invoice UUID',
          order_id VARCHAR(36) NULL COMMENT 'Order id',
          invoice_no VARCHAR(40) NOT NULL UNIQUE COMMENT 'PI number',
          invoice_date DATE NOT NULL COMMENT 'Invoice date',
          currency VARCHAR(10) DEFAULT 'USD' COMMENT 'Currency',
          subtotal_amount DECIMAL(12,2) NULL COMMENT 'Goods subtotal',
          shipping_amount DECIMAL(12,2) NULL COMMENT 'Shipping amount',
          total_amount DECIMAL(12,2) NULL COMMENT 'Grand total',
          receiver_json JSON NULL COMMENT 'Receiver snapshot',
          products_json JSON NULL COMMENT 'Products snapshot',
          pdf_path VARCHAR(500) NULL COMMENT 'PDF storage path',
          html_path VARCHAR(500) NULL COMMENT 'HTML storage path',
          json_path VARCHAR(500) NULL COMMENT 'JSON backup path',
          public_url VARCHAR(500) NULL COMMENT 'Public file url',
          generated_by INT NULL COMMENT 'Generated by user id',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_order_id (order_id),
          INDEX idx_invoice_date (invoice_date),
          INDEX idx_generated_by (generated_by)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Generated order invoices'
      `)
      console.log('order_invoices table ready')
    } catch (e) {
      console.log('order_invoices table migration skipped:', e.message.split('\n')[0])
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS order_option_values (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Option UUID',
          option_type VARCHAR(40) NOT NULL COMMENT 'payment_platform/domestic_platform/courier/country/city',
          option_value VARCHAR(160) NOT NULL COMMENT 'Option value',
          sort_order INT DEFAULT 0 COMMENT 'Sort order',
          created_by INT NULL COMMENT 'Created by user id',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_type_value (option_type, option_value),
          INDEX idx_type_sort (option_type, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order form shared option values'
      `)
      console.log('order_option_values table ready')
    } catch (e) {
      console.log('order_option_values table migration skipped:', e.message.split('\n')[0])
    }

    const defaultOrderOptions = [
      { type: 'payment_platform', value: 'PayPal', sort: 10 },
      { type: 'payment_platform', value: '万里汇', sort: 20 },
      { type: 'payment_platform', value: '微信', sort: 30 },
      { type: 'payment_platform', value: '支付宝', sort: 40 },
      { type: 'domestic_platform', value: '千牛', sort: 10 },
      { type: 'domestic_platform', value: '抖音', sort: 20 },
      { type: 'domestic_platform', value: '小红书', sort: 30 },
      { type: 'domestic_platform', value: '拼多多', sort: 40 },
      { type: 'domestic_platform', value: '微信小店孤勇者', sort: 50 },
      { type: 'domestic_platform', value: '1688', sort: 60 },
      { type: 'domestic_platform', value: '微信小店艾贝斯', sort: 70 },
      { type: 'domestic_platform', value: '手工单国内', sort: 80 },
      { type: 'domestic_platform', value: '手工单国外', sort: 90 },
      { type: 'domestic_platform', value: '施工', sort: 100 },
      { type: 'courier', value: '苏州-通世', sort: 10 },
      { type: 'courier', value: '上海-化工', sort: 20 },
      { type: 'courier', value: '沙特-化工', sort: 30 },
      { type: 'courier', value: '李岩-万邦', sort: 40 },
      { type: 'courier', value: '白云-正午', sort: 50 }
    ]
    for (const item of defaultOrderOptions) {
      try {
        await sequelize.query(
          `INSERT INTO order_option_values (id, option_type, option_value, sort_order, created_at, updated_at)
           SELECT UUID(), :type, :value, :sort, NOW(), NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM order_option_values WHERE option_type = :type AND option_value = :value
           )`,
          { replacements: item }
        )
        await sequelize.query(
          `UPDATE order_option_values
           SET sort_order = :sort, updated_at = NOW()
           WHERE option_type = :type AND option_value = :value`,
          { replacements: item }
        )
      } catch (e) {
        // Ignore duplicate seed races.
      }
    }
    for (const oldDomesticOption of ['微信', '手工单']) {
      try {
        await sequelize.query(
          `DELETE FROM order_option_values
           WHERE option_type = 'domestic_platform'
             AND option_value = :value
             AND created_by IS NULL`,
          { replacements: { value: oldDomesticOption } }
        )
      } catch (e) {
        // Keep startup tolerant if the option table is managed externally.
      }
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS order_attachments (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Attachment UUID',
          order_id VARCHAR(36) NOT NULL COMMENT 'Order id',
          original_name VARCHAR(255) NOT NULL COMMENT 'Original file name',
          filename VARCHAR(255) NOT NULL COMMENT 'Stored file name',
          mime_type VARCHAR(120) NULL COMMENT 'MIME type',
          size BIGINT DEFAULT 0 COMMENT 'File size',
          storage_path VARCHAR(500) NOT NULL COMMENT 'Storage path',
          public_url VARCHAR(500) NOT NULL COMMENT 'Public url',
          attachment_type VARCHAR(40) DEFAULT 'file' COMMENT 'file/invoice/payment/logistics/other',
          uploaded_by INT NULL COMMENT 'Uploader user id',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_order_id (order_id),
          INDEX idx_attachment_type (attachment_type),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Order attachments'
      `)
      console.log('order_attachments table ready')
    } catch (e) {
      console.log('order_attachments table migration skipped:', e.message.split('\n')[0])
    }

    // ---- Migration: customer management table ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS customers (
          id VARCHAR(36) PRIMARY KEY COMMENT 'Customer UUID',
          phone VARCHAR(60) NOT NULL COMMENT 'Customer phone number',
          contact_time DATETIME NULL COMMENT 'Customer contact or follow-up time',
          notes TEXT NULL COMMENT 'Customer notes',
          created_by INT NULL COMMENT 'Created by user id',
          updated_by INT NULL COMMENT 'Updated by user id',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_phone (phone),
          INDEX idx_contact_time (contact_time),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer management records'
      `)
      console.log('customers table ready')
    } catch (e) {
      console.log('customers table migration skipped:', e.message.split('\n')[0])
    }

    // ---- 迁移：知识库源文件留存表（用于后台下载原始文档编辑）----
    // ---- customer profile and follow-up operations ----
    const customerProfileColumns = [
      { col: 'display_name', def: 'VARCHAR(120) NULL COMMENT "Customer display name" AFTER phone' },
      { col: 'owner_id', def: 'INT NULL COMMENT "Current customer owner" AFTER notes' },
      { col: 'won_status', def: "VARCHAR(20) DEFAULT 'unknown' COMMENT 'unknown/won/not_won' AFTER owner_id" },
      { col: 'won_at', def: 'DATETIME NULL COMMENT "Customer won time" AFTER won_status' },
      { col: 'ai_profile', def: 'JSON NULL COMMENT "AI customer profile" AFTER won_at' },
      { col: 'ai_profile_updated_at', def: 'DATETIME NULL COMMENT "AI profile update time" AFTER ai_profile' }
    ]
    for (const { col, def } of customerProfileColumns) {
      try {
        await sequelize.query(`ALTER TABLE customers ADD COLUMN ${col} ${def}`)
      } catch (e) {
        // Column already exists on upgraded installations.
      }
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_identities (
          id VARCHAR(36) PRIMARY KEY,
          customer_id VARCHAR(36) NOT NULL,
          channel VARCHAR(30) NOT NULL,
          account_id INT NULL,
          external_user_id VARCHAR(191) NOT NULL,
          phone VARCHAR(60) NULL,
          display_name VARCHAR(120) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_customer_identity (channel, account_id, external_user_id),
          INDEX idx_customer_identity_customer (customer_id),
          INDEX idx_customer_identity_phone (phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer channel identities'
      `)
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_communication_days (
          id VARCHAR(36) PRIMARY KEY,
          customer_id VARCHAR(36) NOT NULL,
          communication_date DATE NOT NULL,
          communication_index INT DEFAULT 1,
          stage_label VARCHAR(20) DEFAULT 'first',
          message_count INT DEFAULT 0,
          first_message_at DATETIME NULL,
          last_message_at DATETIME NULL,
          owner_id INT NULL,
          conversation_ids JSON NULL,
          summary TEXT NULL,
          ai_pending TINYINT(1) DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_customer_communication_day (customer_id, communication_date),
          INDEX idx_communication_day_owner (owner_id, communication_date),
          INDEX idx_communication_day_customer (customer_id, communication_date),
          INDEX idx_communication_day_pending (ai_pending, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer daily communication records'
      `)
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_followups (
          id VARCHAR(36) PRIMARY KEY,
          customer_id VARCHAR(36) NOT NULL,
          conversation_id VARCHAR(36) NULL,
          order_id VARCHAR(36) NULL,
          type VARCHAR(30) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          due_at DATETIME NOT NULL,
          completed_at DATETIME NULL,
          assigned_to INT NULL,
          source VARCHAR(30) DEFAULT 'ai',
          ai_reason TEXT NULL,
          ai_confidence DECIMAL(5,4) NULL,
          ai_signals JSON NULL,
          overridden_by INT NULL,
          override_reason TEXT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_customer_followup_order_type (order_id, type),
          INDEX idx_customer_followup_customer (customer_id, status, due_at),
          INDEX idx_customer_followup_assignee (assigned_to, status, due_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer follow-up tasks'
      `)
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_daily_reports (
          id VARCHAR(36) PRIMARY KEY,
          report_date DATE NOT NULL,
          scope_type VARCHAR(20) NOT NULL,
          scope_id INT NULL,
          customer_count INT DEFAULT 0,
          first_count INT DEFAULT 0,
          second_count INT DEFAULT 0,
          third_count INT DEFAULT 0,
          won_count INT DEFAULT 0,
          due_count INT DEFAULT 0,
          overdue_count INT DEFAULT 0,
          summary TEXT NULL,
          details JSON NULL,
          model_name VARCHAR(100) NULL,
          generated_at DATETIME NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_customer_daily_report_scope (report_date, scope_type, scope_id),
          INDEX idx_customer_daily_report_date (report_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer daily reports'
      `)
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_ai_audit_logs (
          id VARCHAR(36) PRIMARY KEY,
          customer_id VARCHAR(36) NULL,
          followup_id VARCHAR(36) NULL,
          report_date DATE NULL,
          action_type VARCHAR(30) NOT NULL,
          source VARCHAR(20) NOT NULL,
          input_summary JSON NULL,
          output JSON NULL,
          model_name VARCHAR(100) NULL,
          confidence DECIMAL(5,4) NULL,
          error_message TEXT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_customer_ai_audit_customer (customer_id, created_at),
          INDEX idx_customer_ai_audit_followup (followup_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer AI decision audit logs'
      `)
      console.log('customer operations tables ready')
    } catch (e) {
      console.log('customer operations table migration skipped:', e.message.split('\n')[0])
    }

    // ---- 客户工作区稳定关联、版本、证据和可重放事件 ----
    for (const [table, definition] of [
      ['customer_communication_events', `
        CREATE TABLE IF NOT EXISTS customer_communication_events (
          id VARCHAR(36) PRIMARY KEY,
          message_id VARCHAR(120) NOT NULL,
          event_type VARCHAR(40) NOT NULL,
          customer_id VARCHAR(36) NULL,
          conversation_id VARCHAR(36) NULL,
          owner_id INT NULL,
          communication_date DATE NULL,
          payload JSON NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_customer_message_event (message_id, event_type),
          INDEX idx_customer_comm_event_customer (customer_id, created_at),
          INDEX idx_customer_comm_event_conversation (conversation_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
      ['customer_operation_events', `
        CREATE TABLE IF NOT EXISTS customer_operation_events (
          id VARCHAR(36) PRIMARY KEY,
          event_key VARCHAR(191) NOT NULL,
          event_type VARCHAR(40) NOT NULL,
          payload JSON NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          attempts INT NOT NULL DEFAULT 0,
          available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          worker_id VARCHAR(120) NULL,
          lease_until DATETIME NULL,
          last_error_code VARCHAR(80) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_customer_operation_event (event_key),
          INDEX idx_customer_operation_event_claim (status, available_at, lease_until)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
      ['customer_tags', `
        CREATE TABLE IF NOT EXISTS customer_tags (
          customer_id VARCHAR(36) NOT NULL,
          tag_key VARCHAR(80) NOT NULL,
          tag_value VARCHAR(191) NULL,
          source VARCHAR(30) NOT NULL DEFAULT 'ai',
          confidence DECIMAL(5,4) NULL,
          created_by INT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (customer_id, tag_key),
          INDEX idx_customer_tag_value (tag_key, tag_value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
      ['customer_profile_corrections', `
        CREATE TABLE IF NOT EXISTS customer_profile_corrections (
          id VARCHAR(36) PRIMARY KEY,
          customer_id VARCHAR(36) NOT NULL,
          field_key VARCHAR(80) NOT NULL,
          old_value JSON NULL,
          new_value JSON NULL,
          reason VARCHAR(500) NULL,
          corrected_by INT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_customer_profile_correction (customer_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
      ['customer_audit_logs', `
        CREATE TABLE IF NOT EXISTS customer_audit_logs (
          id VARCHAR(36) PRIMARY KEY,
          customer_id VARCHAR(36) NULL,
          conversation_id VARCHAR(36) NULL,
          action VARCHAR(60) NOT NULL,
          actor_id INT NULL,
          before_json JSON NULL,
          after_json JSON NULL,
          reason VARCHAR(500) NULL,
          idempotency_key VARCHAR(191) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_customer_audit_customer (customer_id, created_at),
          INDEX idx_customer_audit_actor (actor_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
      ['customer_daily_report_revisions', `
        CREATE TABLE IF NOT EXISTS customer_daily_report_revisions (
          id VARCHAR(36) PRIMARY KEY,
          report_date DATE NOT NULL,
          scope_type VARCHAR(20) NOT NULL,
          scope_id INT NULL,
          revision INT NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'current',
          snapshot JSON NOT NULL,
          generated_by INT NULL,
          generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_report_revision (report_date, scope_type, scope_id, revision),
          INDEX idx_report_revision_lookup (report_date, scope_type, scope_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`]
    ]) {
      try { await sequelize.query(definition) } catch (e) {
        console.log(`${table} migration skipped:`, e.message.split('\n')[0])
      }
    }
    // ALTER TABLE customers ADD COLUMN version and ALTER TABLE orders ADD COLUMN customer_id
    // are intentionally additive for existing installations.
    for (const [table, column, definition] of [
      ['customers', 'version', 'INT NOT NULL DEFAULT 1'],
      ['orders', 'customer_id', 'VARCHAR(36) NULL'],
      ['customer_followups', 'version', 'INT NOT NULL DEFAULT 1'],
      ['customer_communication_days', 'source_conversation_id', 'VARCHAR(36) NULL'],
      ['customer_communication_days', 'source_owner_id', 'INT NULL'],
      ['customer_identities', 'normalized_account_key', "VARCHAR(80) NOT NULL DEFAULT '__none__'"]
    ]) {
      try { await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`) } catch (e) {
        console.log(`${table}.${column} migration skipped`)
      }
    }
    try {
      await sequelize.query(`UPDATE customer_identities SET normalized_account_key = COALESCE(CAST(account_id AS CHAR), '__none__')`)
      await sequelize.query(`ALTER TABLE customer_identities ADD UNIQUE KEY uk_customer_identity_normalized (channel, normalized_account_key, external_user_id)`)
    } catch (e) {
      console.log('customer identity normalized index migration skipped')
    }

    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS knowledge_document_sources (
          id VARCHAR(36) PRIMARY KEY COMMENT '源文件记录 UUID',
          document_id VARCHAR(100) NULL COMMENT '百炼索引文档 ID',
          file_id VARCHAR(100) NULL COMMENT '百炼数据中心文件 ID',
          job_id VARCHAR(100) NULL COMMENT '索引任务 ID',
          original_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
          stored_name VARCHAR(255) NOT NULL COMMENT '本地存储文件名',
          mime_type VARCHAR(100) NULL COMMENT 'MIME 类型',
          size BIGINT DEFAULT 0 COMMENT '文件大小（字节）',
          storage_path VARCHAR(500) NOT NULL COMMENT '本地存储路径',
          source_mode VARCHAR(20) DEFAULT 'aliyun' COMMENT '上传模式：aliyun/local',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_document_id (document_id),
          INDEX idx_file_id (file_id),
          INDEX idx_job_id (job_id),
          INDEX idx_original_size (original_name, size),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='知识库文档源文件留存表'
      `)
      console.log('knowledge_document_sources 表创建完成')
    } catch (e) {
      console.log('knowledge_document_sources 表已存在，跳过')
    }

    // ---- 迁移：快捷指令表（用于客服输入框 / 指令选择）----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS quick_replies (
          id VARCHAR(36) PRIMARY KEY COMMENT '快捷指令 UUID',
          title VARCHAR(100) NOT NULL COMMENT '指令标题',
          shortcut VARCHAR(80) NOT NULL COMMENT '触发词，如 /price',
          content MEDIUMTEXT NOT NULL COMMENT '回复内容',
          category VARCHAR(50) NULL COMMENT '分类',
          is_enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用',
          sort_order INT DEFAULT 0 COMMENT '排序，越小越靠前',
          usage_count INT DEFAULT 0 COMMENT '使用次数',
          created_by INT NULL COMMENT '创建人 ID',
          updated_by INT NULL COMMENT '更新人 ID',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_shortcut (shortcut),
          INDEX idx_enabled_sort (is_enabled, sort_order),
          INDEX idx_category (category),
          INDEX idx_updated_at (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客服快捷指令表'
      `)
      console.log('quick_replies 表创建完成')
    } catch (e) {
      console.log('quick_replies 表已存在，跳过')
    }

    // ---- 迁移：AI 回复业务日志表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS ai_reply_logs (
          id VARCHAR(36) PRIMARY KEY COMMENT '日志 UUID',
          conversation_id VARCHAR(36) NOT NULL COMMENT '关联 conversations.id',
          job_id VARCHAR(100) NULL COMMENT 'BullMQ 任务 ID',
          status VARCHAR(30) DEFAULT 'pending' COMMENT '状态：success / retrying / failed_transferred / transferred / skipped',
          reason TEXT NULL COMMENT '原因说明（失败原因/转人工原因等）',
          retry_count INT DEFAULT 0 COMMENT '重试次数',
          extra JSON NULL COMMENT '诊断摘要（RAG分数/命中文档/触发器等）',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_conversation_id (conversation_id),
          INDEX idx_status (status),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 回复业务事件日志'
      `)
      console.log('ai_reply_logs 表创建完成')
    } catch (e) {
      console.log('ai_reply_logs 表已存在，跳过')
    }

    try {
      await sequelize.query(`ALTER TABLE ai_reply_logs ADD COLUMN extra JSON NULL COMMENT '诊断摘要（RAG分数/命中文档/触发器等）' AFTER retry_count`)
      console.log('ai_reply_logs.extra 字段已添加')
    } catch (e) {
      console.log('ai_reply_logs.extra 字段已存在，跳过')
    }

    // ---- 迁移：AI 推荐 QA 反馈表（用于沉淀可更新 RAG 的问答数据）----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS ai_suggest_qa_records (
          id VARCHAR(36) PRIMARY KEY COMMENT '记录 UUID',
          conversation_id VARCHAR(36) NOT NULL COMMENT '关联 conversations.id',
          message_id VARCHAR(36) NOT NULL COMMENT '触发反馈的 plat_messages.id',
          channel VARCHAR(30) NULL COMMENT '渠道',
          account_id INT NULL COMMENT '渠道账号 ID',
          user_id VARCHAR(100) NULL COMMENT '外部客户标识',
          question TEXT NOT NULL COMMENT '客户问题',
          answer MEDIUMTEXT NOT NULL COMMENT 'AI 推荐回答/坐席可采纳答案',
          answer_cn MEDIUMTEXT NULL COMMENT '中文版本（非中文客户时）',
          knowledge_scope VARCHAR(20) DEFAULT 'common' COMMENT '知识适用范围：common/overseas/domestic/channel',
          knowledge_channels JSON NULL COMMENT '适用渠道：all/whatsapp/wechat/douyin',
          customer_lang VARCHAR(20) DEFAULT 'zh' COMMENT '客户语言：zh/other',
          model VARCHAR(100) NULL COMMENT '生成模型',
          feedback VARCHAR(20) DEFAULT 'none' COMMENT '反馈：none/up/down',
          feedback_note TEXT NULL COMMENT '反馈备注/原因',
          sources JSON NULL COMMENT '检索来源快照',
          context_messages JSON NULL COMMENT '点赞时的完整消息上下文区间',
          created_by INT NULL COMMENT '创建/反馈操作人',
          updated_by INT NULL COMMENT '最近更新人',
          status VARCHAR(20) DEFAULT 'pending' COMMENT '处理状态：pending/accepted/rejected/exported',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_message_answer (message_id, answer(255)),
          INDEX idx_conversation_id (conversation_id),
          INDEX idx_message_id (message_id),
          INDEX idx_feedback (feedback),
          INDEX idx_knowledge_scope (knowledge_scope),
          INDEX idx_status (status),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 推荐 QA 反馈记录表'
      `)
      console.log('ai_suggest_qa_records 表创建完成')
    } catch (e) {
      console.log('ai_suggest_qa_records 表已存在，跳过')
    }

    try {
      await sequelize.query(`ALTER TABLE ai_suggest_qa_records ADD COLUMN knowledge_scope VARCHAR(20) DEFAULT 'common' COMMENT '知识适用范围：common/overseas/domestic/channel' AFTER answer_cn`)
      console.log('ai_suggest_qa_records.knowledge_scope 字段已添加')
    } catch (e) {
      console.log('ai_suggest_qa_records.knowledge_scope 字段已存在，跳过')
    }

    try {
      await sequelize.query(`ALTER TABLE ai_suggest_qa_records ADD COLUMN knowledge_channels JSON NULL COMMENT '适用渠道：all/whatsapp/wechat/douyin' AFTER knowledge_scope`)
      console.log('ai_suggest_qa_records.knowledge_channels 字段已添加')
    } catch (e) {
      console.log('ai_suggest_qa_records.knowledge_channels 字段已存在，跳过')
    }

    try {
      await sequelize.query(`ALTER TABLE ai_suggest_qa_records ADD COLUMN context_messages JSON NULL COMMENT '点赞时的完整消息上下文区间' AFTER sources`)
      console.log('ai_suggest_qa_records.context_messages 字段已添加')
    } catch (e) {
      console.log('ai_suggest_qa_records.context_messages 字段已存在，跳过')
    }

    try {
      await sequelize.query('ALTER TABLE ai_suggest_qa_records ADD INDEX idx_knowledge_scope (knowledge_scope)')
      console.log('ai_suggest_qa_records idx_knowledge_scope 索引添加完成')
    } catch (e) {
      console.log('ai_suggest_qa_records idx_knowledge_scope 索引已存在，跳过')
    }

    // ---- 迁移：聚合平台消息表 ----
    try {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS plat_messages (
          id VARCHAR(36) PRIMARY KEY COMMENT '消息 UUID',
          conversation_id VARCHAR(36) NOT NULL COMMENT '关联 conversations.id',
          channel VARCHAR(30) NOT NULL COMMENT '渠道标识',
          account_id INT NULL COMMENT '渠道账号 ID',
          user_id VARCHAR(100) NULL COMMENT '外部用户标识',
          direction VARCHAR(10) NOT NULL COMMENT '消息方向：inbound / outbound',
          sender_type VARCHAR(20) NULL COMMENT '发送方类型：customer / agent / ai / system',
          message_type VARCHAR(20) DEFAULT 'text' COMMENT '消息类型：text / image / video / file',
          content JSON NULL COMMENT '消息内容（JSON格式，如 {text: "..."}）',
          channel_message_id VARCHAR(100) NULL COMMENT '渠道原始消息 ID（幂等去重）',
          send_status VARCHAR(20) DEFAULT 'received' COMMENT '发送状态：received / sent / failed',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_conversation_id (conversation_id),
          INDEX idx_direction (direction),
          INDEX idx_sender_type (sender_type),
          INDEX idx_channel_message_id (channel_message_id),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聚合平台消息表'
      `)
      console.log('plat_messages 表创建完成')
    } catch (e) {
      console.log('plat_messages 表已存在，跳过')
    }

    // ---- 迁移：plat_messages 新增 sender_type 字段（兼容已存在的表）----
    try {
      await sequelize.query(
        `ALTER TABLE plat_messages ADD COLUMN sender_type VARCHAR(20) NULL COMMENT '发送方类型：customer / agent / ai / system' AFTER direction`
      )
      console.log('plat_messages.sender_type 字段添加完成')
    } catch (e) {
      // 字段已存在，忽略
    }

    // ---- 迁移：plat_messages 新增 sender_id 字段（记录人工消息所属坐席，便于统计横向比较）----
    try {
      await sequelize.query(
        `ALTER TABLE plat_messages ADD COLUMN sender_id INT NULL COMMENT '发送人用户ID：人工客服消息记录坐席ID，AI/客户/系统为空' AFTER sender_type`
      )
      console.log('plat_messages.sender_id 字段添加完成')
    } catch (e) {
      // 字段已存在，忽略
    }

    // ---- 迁移：plat_messages sender_type 索引 ----
    try {
      await sequelize.query(
        'ALTER TABLE plat_messages ADD INDEX idx_sender_type (sender_type)'
      )
      console.log('plat_messages idx_sender_type 索引添加完成')
    } catch (e) {
      // 索引已存在，忽略
    }

    try {
      await sequelize.query(
        'ALTER TABLE plat_messages ADD INDEX idx_sender_id_created (sender_id, created_at)'
      )
      console.log('plat_messages idx_sender_id_created 索引添加完成')
    } catch (e) {
      // 索引已存在，忽略
    }

    // ---- 迁移：plat_messages 搜索优化索引 ----
    const msgNewIndexes = [
      // 复合索引：优化列表查询中的 COUNT 子查询（WHERE conversation_id=? AND direction=? AND send_status=?）
      { name: 'idx_conv_dir', sql: 'ALTER TABLE plat_messages ADD INDEX idx_conv_dir (conversation_id, direction)' },
      // 复合索引：优化全局搜索中的消息匹配（WHERE conversation_id=? ORDER BY created_at DESC）
      { name: 'idx_conv_created', sql: 'ALTER TABLE plat_messages ADD INDEX idx_conv_created (conversation_id, created_at)' }
    ]
    for (const { name, sql } of msgNewIndexes) {
      try {
        await sequelize.query(sql)
        console.log(`plat_messages 索引 ${name} 添加完成`)
      } catch (e) {
        // 索引已存在，忽略
      }
    }

    // ---- 迁移：conversations 全文搜索索引（FULLTEXT + ngram，支持中文分词）----
    // 用于未来优化 LIKE '%keyword%' → MATCH() AGAINST() 搜索
    try {
      await sequelize.query(
        `ALTER TABLE conversations ADD FULLTEXT INDEX ft_user_search (user_name, last_message) WITH PARSER ngram`
      )
      console.log('conversations FULLTEXT 索引 ft_user_search 添加完成')
    } catch (e) {
      // 索引已存在或不支持 ngram parser，忽略
    }
  } catch (syncError) {
    console.error(`表同步失败: ${syncError.message}`)
    // 如果索引过多，提示手动清理
    if (syncError.message.includes('Too many keys')) {
      console.error('建议：删除现有表并重新创建，或手动清理冗余索引')
      console.error('SQL命令：DROP TABLE IF EXISTS threads, runs, documents, users;')
    }
  }

  // The commerce sync worker must not start unless its persistent cursor table is ready.
  await ensureChannelSyncStateSchema(sequelize)
  console.log('渠道同步游标表初始化完成')

  // ---- 初始化管理员账号 ----
  try {
    const User = require('../models/User')
    const bcrypt = require('bcryptjs')
    const existing = await User.findOne({ where: { role: 'admin' } })
    if (!existing && adminSeedPassword) {
      const hashedPassword = await bcrypt.hash(adminSeedPassword, 12)
      await User.create({
        username: 'admin',
        password: hashedPassword,
        email: 'admin@system.local',
        role: 'admin',
        status: 'active'
      })
      console.log('')
      console.log('================================================')
      console.log('  管理员账号已自动创建')
      console.log(`  用户名: admin`)
      console.log('  请登录后及时修改密码！')
      console.log('================================================')
      console.log('')
    } else if (!existing) {
      console.log('ADMIN_SEED_PASSWORD is not configured; automatic administrator seeding is disabled')
    }
  } catch (initError) {
    console.error('管理员初始化失败:', initError.message)
  }
}

module.exports = {
  sequelize,
  connectDB
}
