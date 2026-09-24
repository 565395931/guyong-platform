const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

/**
 * 渠道账号模型
 *
 * 存储各渠道（WhatsApp/WAHA 等）绑定的账号配置。
 * config 字段存储加密后的 JSON（含 API Key、session 名称等敏感信息）。
 */
const ChannelAccount = sequelize.define('ChannelAccount', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  channel: {
    type: DataTypes.STRING(30),
    allowNull: false,
    comment: '渠道标识：whatsapp / douyin / wechat'
  },
  account_name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    comment: '账号显示名称'
  },
  config: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '加密后的配置 JSON（API Key、session 等）'
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    defaultValue: 'active',
    comment: '账号状态'
  },
  adapter_type: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'waha',
    comment: '适配器类型：waha / waaku 等'
  },
  daily_quota: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: '今日已用配额'
  },
  max_daily_quota: {
    type: DataTypes.INTEGER,
    defaultValue: 1000,
    comment: '每日最大配额'
  },
  phone_number: {
    type: DataTypes.STRING(30),
    allowNull: true,
    comment: 'WhatsApp 手机号（扫码绑定后自动填充）'
  },
  whatsapp_name: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'WhatsApp 显示名称（扫码绑定后自动填充）'
  },
  knowledge_scope: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: '默认知识范围：common/overseas/domestic/channel'
  },
  knowledge_channels: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: '默认适用渠道：all/whatsapp/wechat/douyin'
  }
}, {
  tableName: 'channel_accounts',
  timestamps: true,
  underscored: true
})

module.exports = ChannelAccount
