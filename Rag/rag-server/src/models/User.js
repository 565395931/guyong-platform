const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

// 用户模型
const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
    comment: '用户名'
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: '密码（加密存储）'
  },
  email: {
    type: DataTypes.STRING(100),
    allowNull: true,
    unique: true,
    comment: '邮箱'
  },
  role: {
    type: DataTypes.ENUM('user', 'agent', 'supervisor', 'admin'),
    defaultValue: 'user',
    comment: '角色（user/agent/supervisor/admin）'
  },
  status: {
    type: DataTypes.STRING(10),
    defaultValue: 'active',
    comment: '状态（active/disabled）'
  },
  skills: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: '技能标签（坐席专用）'
  },
  maxConcurrent: {
    type: DataTypes.INTEGER,
    defaultValue: 5,
    comment: '最大并发接待数（坐席专用）'
  }
}, {
  tableName: 'users',
  comment: '用户表'
})

module.exports = User