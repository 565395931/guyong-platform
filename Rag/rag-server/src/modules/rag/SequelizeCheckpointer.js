/**
 * SequelizeCheckpointer - 基于 Sequelize/MySQL 的 LangChain Checkpointer 实现
 * 使用 Thread 数据库模型持久化会话历史
 */

const { BaseCheckpointSaver } = require('@langchain/langgraph-checkpoint');

// Thread 模型将在使用时导入
let Thread = null;

/**
 * SequelizeCheckpointer 类
 * 实现 LangChain BaseCheckpointSaver 接口，基于 Thread 数据库表
 */
class SequelizeCheckpointer extends BaseCheckpointSaver {
  constructor() {
    super();
    // 延迟导入 Thread 模型，避免循环依赖
    if (!Thread) {
      Thread = require('../../models/Thread').Thread;
    }
  }

  /**
   * 存储 checkpoint
   * @param {Object} config - RunnableConfig，包含 thread_id
   * @param {Object} checkpoint - Checkpoint 对象
   * @param {Object} metadata - Checkpoint 元数据
   * @returns {Object} 新的 config
   */
  async put(config, checkpoint, metadata) {
    const threadId = config?.configurable?.thread_id;
    
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    // 从 checkpoint 中提取消息
    const messages = checkpoint?.channel_values?.messages || [];
    
    // 查找或创建 Thread
    let thread = await Thread.findOne({ where: { thread_id: threadId } });
    
    if (!thread) {
      // 创建新 Thread
      thread = await Thread.create({
        thread_id: threadId,
        status: 'idle',
        messages: []
      });
    }

    // 更新消息列表
    thread.messages = this.serializeMessages(messages);
    thread.status = 'idle';
    await thread.save();

    return { configurable: { thread_id: threadId, checkpoint_id: checkpoint.id } };
  }

  /**
   * 获取 checkpoint tuple
   * @param {Object} config - RunnableConfig，包含 thread_id
   * @returns {Object|null} CheckpointTuple 或 null
   */
  async getTuple(config) {
    const threadId = config?.configurable?.thread_id;
    
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    const thread = await Thread.findOne({ where: { thread_id: threadId } });
    
    if (!thread) {
      return null;
    }

    // 从数据库反序列化消息
    const messages = this.deserializeMessages(thread.messages || []);

    // 构建 checkpoint
    const checkpoint = {
      channel_values: {
        messages: messages
      },
      channel_versions: {},
      versions_seen: {},
      id: threadId,
      ts: new Date().toISOString()
    };

    // 构建 metadata
    const metadata = {
      source: 'input',
      step: 0,
      writes: null,
      parents: {}
    };

    return {
      config,
      checkpoint,
      metadata,
      pendingWrites: []
    };
  }

  /**
   * 列出所有 checkpoints
   * @param {Object} config - RunnableConfig
   * @param {Object} options - 选项 { before, limit, filter }
   * @returns {AsyncGenerator} CheckpointTuple 生成器
   */
  async *list(config, options) {
    const { limit } = options || {};
    const threadId = config?.configurable?.thread_id;
    
    if (!threadId) {
      // 如果没有指定 thread_id，列出所有 Thread
      const threads = await Thread.findAll({ limit: limit || 10 });
      for (const thread of threads) {
        yield this.threadToTuple(thread, config);
      }
      return;
    }

    const thread = await Thread.findOne({ where: { thread_id: threadId } });
    
    if (!thread) {
      return;
    }

    yield this.threadToTuple(thread, config);
  }

  /**
   * 存储 pending writes
   * @param {Object} config - RunnableConfig
   * @param {Array} writes - 写入列表 [[channel, value], ...]
   * @param {string} taskId - 任务ID
   */
  async putWrites(config, writes, taskId) {
    // 暂不实现，因为 Thread 表结构不支持复杂的 pending writes
    // 对于简单的对话场景，只存储消息即可
  }

  /**
   * 删除 thread
   * @param {string} threadId - Thread ID
   */
  async deleteThread(threadId) {
    const thread = await Thread.findOne({ where: { thread_id: threadId } });
    
    if (thread) {
      await thread.destroy();
    }
  }

  // ========== 辅助方法 ==========

  /**
   * 序列化消息（LangChain Message → 简单对象）
   * @param {Array} messages - LangChain Message 数组
   * @returns {Array} 简单对象数组
   */
  serializeMessages(messages) {
    return messages.map(msg => {
      const baseObj = {
        type: msg._getType(),
        content: msg.content,
        timestamp: new Date().toISOString()  // 添加时间戳
      };
      
      // 如果消息有额外的 metadata，也保存下来
      if (msg.response_metadata) {
        baseObj.response_metadata = msg.response_metadata;
      }
      
      return baseObj;
    });
  }

  /**
   * 反序列化消息（简单对象 → LangChain Message）
   * @param {Array} messages - 简单对象数组
   * @returns {Array} LangChain Message 数组
   */
  deserializeMessages(messages) {
    const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');

    return messages.map(msg => {
      if (msg.type === 'human') {
        return new HumanMessage(msg.content);
      } else if (msg.type === 'ai') {
        // 处理阿里云百炼返回的数组格式 content
        // 数组格式：[{ type: 'reasoning', reasoning: '...' }, { type: 'text', text: '...' }]
        // 字符串格式：直接是文本
        let content = msg.content;

        // 如果 content 是数组，提取纯文本部分
        if (Array.isArray(content)) {
          const textBlock = content.find(block => block.type === 'text');
          content = textBlock?.text || '';

          console.log('[SequelizeCheckpointer] AI消息数组格式，提取文本长度:', content.length);
        }

        return new AIMessage(content);
      } else if (msg.type === 'system') {
        return new SystemMessage(msg.content);
      } else {
        return new HumanMessage(msg.content);
      }
    });
  }

  /**
   * 将 Thread 转换为 CheckpointTuple
   * @param {Object} thread - Thread 数据库实例
   * @param {Object} config - RunnableConfig
   * @returns {Object} CheckpointTuple
   */
  threadToTuple(thread, config) {
    const messages = this.deserializeMessages(thread.messages || []);

    const checkpoint = {
      channel_values: {
        messages: messages
      },
      channel_versions: {},
      versions_seen: {},
      id: thread.thread_id,
      ts: thread.created_at?.toISOString() || new Date().toISOString()
    };

    const metadata = {
      source: 'input',
      step: 0,
      writes: null,
      parents: {}
    };

    return {
      config,
      checkpoint,
      metadata,
      pendingWrites: []
    };
  }
}

module.exports = { SequelizeCheckpointer };
