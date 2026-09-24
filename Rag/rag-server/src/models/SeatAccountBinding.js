const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

/**
 * 坐席账号绑定模型
 *
 * 多渠道账号与坐席的绑定关系，支持 WhatsApp、抖音、微信等渠道。
 * 一个坐席可以绑定多个不同渠道/账号；一个账号也可以被多个坐席同时绑定（多选非排他）。
 * 绑定用于会话列表默认过滤（坐席只看到自己绑定账号的会话），不限制发送权限。
 */
const SeatAccountBinding = sequelize.define('SeatAccountBinding', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  seat_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '坐席用户 ID（关联 users 表）'
  },
  account_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '渠道账号 ID（关联 channel_accounts 表）'
  },
  channel: {
    type: DataTypes.STRING(30),
    allowNull: false,
    comment: '渠道标识：whatsapp / douyin / wechat 等（冗余字段，便于按渠道筛选）'
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    defaultValue: 'active',
    comment: '绑定状态（active=生效 / inactive=已解绑）'
  }
}, {
  tableName: 'seat_account_bindings',
  timestamps: true,
  underscored: true,
  indexes: [
    // 查询某账号被哪些坐席绑定（多选模式下同一账号可绑多坐席）
    { fields: ['account_id', 'status'], name: 'idx_account_status' },
    // 查询坐席的所有绑定
    { fields: ['seat_id', 'status'], name: 'idx_seat_status' },
    // 查询某渠道下坐席的绑定
    { fields: ['seat_id', 'channel', 'status'], name: 'idx_seat_channel_status' }
  ]
})

module.exports = SeatAccountBinding
