const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

// 坐席技能标签字典
const SeatSkillTag = sequelize.define('SeatSkillTag', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
    comment: '技能标签名称'
  },
  sortOrder: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'sort_order',
    comment: '排序值'
  }
}, {
  tableName: 'seat_skill_tags',
  comment: '坐席技能标签字典表'
})

module.exports = SeatSkillTag
