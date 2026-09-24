const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

// Thread 模型（用于 LangGraph 会话）
const Thread = sequelize.define('Thread', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  thread_id: {
    type: DataTypes.STRING(36),
    allowNull: false,
    unique: true,
    comment: '会话UUID'
  },
  user_id: {
    type: DataTypes.STRING(100),
    defaultValue: 'anonymous',
    comment: '用户ID'
  },
  assistant_id: {
    type: DataTypes.STRING(100),
    defaultValue: 'rag-assistant',
    comment: '助手ID'
  },
  status: {
    type: DataTypes.ENUM('idle', 'running', 'error'),
    defaultValue: 'idle',
    comment: '会话状态'
  },
  messages: {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: '消息列表',
    get() {
      const value = this.getDataValue('messages')
      // 确保返回数组，处理 null 或字符串情况
      if (value === null || value === undefined) return []
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return []
        }
      }
      return value
    },
    set(value) {
      // 确保存储正确的 JSON 格式
      this.setDataValue('messages', value || [])
    }
  }
}, {
  tableName: 'threads',
  comment: 'LangGraph会话表',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  // 明确定义索引，避免 Sequelize 自动创建过多索引
  indexes: [
    {
      unique: true,
      fields: ['thread_id'],
      name: 'threads_thread_id_unique'
    },
    {
      fields: ['user_id'],
      name: 'threads_user_id_idx'
    },
    {
      fields: ['status'],
      name: 'threads_status_idx'
    },
    {
      fields: ['created_at'],
      name: 'threads_created_at_idx'
    }
  ]
})

// Run 模型（用于 LangGraph 执行记录）
const Run = sequelize.define('Run', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  run_id: {
    type: DataTypes.STRING(36),
    allowNull: false,
    unique: true,
    comment: '执行UUID'
  },
  thread_id: {
    type: DataTypes.STRING(36),
    allowNull: false,
    comment: '所属会话ID'
  },
  assistant_id: {
    type: DataTypes.STRING(100),
    comment: '助手ID'
  },
  status: {
    type: DataTypes.ENUM('running', 'completed', 'error', 'cancelled', 'awaiting_approval'),
    defaultValue: 'running',
    comment: '执行状态: running/completed/error/cancelled/awaiting_approval'
  },
  input: {
    type: DataTypes.JSON,
    comment: '输入内容'
  },
  output: {
    type: DataTypes.TEXT,
    comment: '输出内容'
  },
  error_message: {
    type: DataTypes.TEXT,
    comment: '错误信息'
  },
  interrupt_data: {
    type: DataTypes.TEXT,
    comment: 'HITL 中断数据（JSON 字符串）'
  }
}, {
  tableName: 'runs',
  comment: 'LangGraph执行记录表',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  // 明确定义索引，避免 Sequelize 自动创建过多索引
  indexes: [
    {
      unique: true,
      fields: ['run_id'],
      name: 'runs_run_id_unique'
    },
    {
      fields: ['thread_id'],
      name: 'runs_thread_id_idx'
    },
    {
      fields: ['status'],
      name: 'runs_status_idx'
    },
    {
      fields: ['created_at'],
      name: 'runs_created_at_idx'
    }
  ]
})

// 定义关联关系
Thread.hasMany(Run, { foreignKey: 'thread_id', sourceKey: 'thread_id', as: 'runs' })
Run.belongsTo(Thread, { foreignKey: 'thread_id', targetKey: 'thread_id', as: 'thread' })

module.exports = { Thread, Run }