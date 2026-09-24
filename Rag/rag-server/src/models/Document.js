const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

// 文档模型
const Document = sequelize.define('Document', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: '文档名称'
  },
  type: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: '文档类型'
  },
  size: {
    type: DataTypes.INTEGER,
    comment: '文件大小（字节）'
  },
  content: {
    type: DataTypes.TEXT,
    comment: '文档内容'
  },
  status: {
    type: DataTypes.STRING(20),
    defaultValue: 'pending',
    comment: '处理状态'
  },
  file_id: {
    type: DataTypes.STRING(100),
    comment: '阿里云百炼文件ID'
  },
  chunks: {
    type: DataTypes.JSON,
    comment: '文本分块及embedding'
  }
}, {
  tableName: 'documents',
  comment: '知识库文档表'
})

module.exports = Document