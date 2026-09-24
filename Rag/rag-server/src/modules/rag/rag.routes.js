const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const controller = require('./rag.controller');
const { createLegacyAdminRouter } = require('./legacyAdmin.routes');

// ========== 依赖引入（streamRun / resumeStream / suggestionStream 内联使用）==========
const langchainService = require('./langchainService');
const ragService = require('./ragService');
const { allTools } = require('./tools');
const { Thread, Run } = require('../../models');
const messagingService = require('../messaging/messaging.service');
const { runWithLimit: suggestionLimiter, checkDedup, startDedup, completeDedup, clearDedup } = require('./suggestionLimiter');
const configService = require('../../services/configService');
const { sanitizeCustomerOutputText } = require('../../services/languageGuard');
const { normalizeKnowledgeMetadata } = require('./knowledgeScope');

const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus';
const JWT_SECRET = process.env.JWT_SECRET || 'rag_secret_key_2024_dev_only';
const uuidv4 = () => crypto.randomUUID();

function optionalJwtUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireQaRecordRole(req, res, next) {
  const user = optionalJwtUser(req);
  if (!user) return res.status(401).json({ success: false, message: '未提供认证令牌' });
  if (!['admin', 'supervisor'].includes(user.role)) {
    return res.status(403).json({ success: false, message: '无权限访问 QA 记录' });
  }
  req.user = user;
  next();
}

function requireKnowledgeManageRole(req, res, next) {
  const user = optionalJwtUser(req);
  if (!user) return res.status(401).json({ success: false, message: '未提供认证令牌' });
  if (!['admin', 'supervisor'].includes(user.role)) {
    return res.status(403).json({ success: false, message: '无权限下载知识库文档' });
  }
  req.user = user;
  next();
}

function looksChinese(text) {
  if (!text || !text.trim()) return false;
  const compact = text.replace(/\s/g, '');
  if (!compact) return false;
  const cjkCount = (compact.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  return cjkCount / compact.length >= 0.3;
}

async function translateSuggestionText(text, targetLang, sourceLang = 'auto-detected source language') {
  if (!text || !text.trim()) return text;
  try {
    const translateModel = await configService.getConfig('llm_translate_model') || 'qwen3.7-plus';
    const { translateText } = require('../../services/translationService');
    return await translateText(text, targetLang, sourceLang, translateModel);
  } catch (err) {
    console.error('[Suggestion] 推荐回复兜底翻译失败:', err.message);
    return text;
  }
}

function buildRetrievalText(originalText, translatedText) {
  const original = String(originalText || '').trim();
  const translated = String(translatedText || '').trim();

  if (translated && translated !== original) {
    return [translated, original].filter(Boolean).join('\n');
  }
  return original || translated;
}

function extractContentRetrievalText(content) {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content || {};
    if (typeof parsed === 'string') return parsed;
    return buildRetrievalText(parsed.text || parsed.content || '', parsed.translatedText || '');
  } catch {
    return typeof content === 'string' ? content : '';
  }
}

function extractCustomerQuestionText(content) {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content || {};
    if (typeof parsed === 'string') return parsed.trim();
    const text = parsed.text || parsed.content || parsed.caption || '';
    if (text && String(text).trim()) return String(text).trim();
    return '';
  } catch {
    return typeof content === 'string' ? content.trim() : '';
  }
}

function normalizeFeedbackMessage(row) {
  let parsedContent = row.content || null;
  if (typeof row.content === 'string') {
    try {
      parsedContent = JSON.parse(row.content);
    } catch {
      parsedContent = row.content;
    }
  }

  const text = extractCustomerQuestionText(row.content) || extractContentRetrievalText(row.content) || '';
  return {
    id: row.id,
    direction: row.direction,
    senderType: row.sender_type || null,
    messageType: row.message_type || 'text',
    content: parsedContent,
    text,
    createdAt: row.created_at_text || row.created_at
  };
}

async function buildSuggestionFeedbackContext(sequelize, msg) {
  const fallbackQuestion = extractCustomerQuestionText(msg.content) || '[非文本消息]';
  if (!msg?.conversation_id || !msg?.created_at) {
    return {
      question: fallbackQuestion,
      contextMessages: [normalizeFeedbackMessage(msg)]
    };
  }

  const [lastReplyRows] = await sequelize.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_text
     FROM plat_messages
     WHERE conversation_id = :conversationId
       AND direction = 'outbound'
       AND (sender_type IS NULL OR sender_type IN ('agent', 'ai'))
       AND created_at < :currentCreatedAt
     ORDER BY created_at DESC
     LIMIT 1`,
    {
      replacements: {
        conversationId: msg.conversation_id,
        currentCreatedAt: msg.created_at
      }
    }
  );

  const replacements = {
    conversationId: msg.conversation_id,
    currentCreatedAt: msg.created_at
  };
  const afterLastReplyClause = lastReplyRows.length > 0
    ? 'AND created_at > :lastReplyCreatedAt'
    : '';
  if (lastReplyRows.length > 0) {
    replacements.lastReplyCreatedAt = lastReplyRows[0].created_at_text;
  }

  const [messageRows] = await sequelize.query(
    `SELECT id, direction, sender_type, message_type, content,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_text
     FROM plat_messages
     WHERE conversation_id = :conversationId
       ${afterLastReplyClause}
       AND created_at <= :currentCreatedAt
     ORDER BY created_at ASC`,
    { replacements }
  );

  const contextMessages = (messageRows.length > 0 ? messageRows : [msg])
    .map(normalizeFeedbackMessage);

  const questionTexts = messageRows
    .filter(row => row.direction === 'inbound' && (!row.sender_type || row.sender_type === 'customer'))
    .map(row => extractCustomerQuestionText(row.content) || '[非文本消息]')
    .filter(Boolean);

  let question = fallbackQuestion;
  if (questionTexts.length === 1) {
    question = questionTexts[0];
  } else if (questionTexts.length > 1) {
    question = questionTexts.map((text, index) => `${index + 1}. ${text}`).join('\n');
  }

  return { question, contextMessages };
}

async function getRecentCustomerRetrievalTexts(conversationId, limit = 3) {
  if (!conversationId || limit <= 0) return [];

  try {
    const { sequelize } = require('../../config/database');
    const [rows] = await sequelize.query(
      `SELECT content
       FROM plat_messages
       WHERE conversation_id = :conversationId
         AND direction = 'inbound'
         AND sender_type = 'customer'
         AND message_type = 'text'
       ORDER BY created_at DESC
       LIMIT :limit`,
      { replacements: { conversationId, limit } }
    );

    return rows
      .reverse()
      .map(row => extractContentRetrievalText(row.content))
      .filter(Boolean);
  } catch (err) {
    console.error('[Suggestion] 获取RAG检索历史失败:', err.message);
    return [];
  }
}

// ========== multer 配置 ==========

// 通用文件过滤器
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件类型，仅支持 PDF、Word、Excel、PPT、TXT、Markdown 格式'));
  }
};

// 通用文件名生成器
const generateFilename = (req, file, cb) => {
  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const timestamp = Date.now();
  const ext = path.extname(originalName);
  const baseName = path.basename(originalName, ext);
  cb(null, `${baseName}_${timestamp}${ext}`);
};

// 1. 百炼直接上传（uploads/）
const bailianUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = './uploads';
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: generateFilename
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter
});

// 2. 本地解析上传（uploads_local/）
const localUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = './uploads_local';
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: generateFilename
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter
});

// 3. 聊天附件上传（uploads_chat_temp/）
const chatAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = './uploads_chat_temp';
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: generateFilename
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter
});

// ========== 内联 SSE 处理函数 ==========

// RAG流式对话（适配 langgraph-vue3-chatbot 组件的 runs/stream 格式）
const streamRunHandler = async (req, res) => {
  const { thread_id, assistant_id, input, config, attachmentDocs } = req.body;

  console.log('[runs/stream] 接收请求:', {
    thread_id,
    inputMessageCount: input?.messages?.length || 0,
    hasAttachment: !!attachmentDocs,
    attachmentCount: attachmentDocs?.length,
    attachmentSample: attachmentDocs?.[0] ? {
      fileName: attachmentDocs[0].fileName,
      textLength: attachmentDocs[0].textContent?.length
    } : null
  });

  if (!thread_id) {
    return res.status(400).json({ error: 'thread_id is required' });
  }

  const userMessage = input?.messages?.[0]?.content || '';
  if (!userMessage) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  console.log('[runs/stream] 用户消息长度:', userMessage.length);

  const model = config?.configurable?.model || DASHSCOPE_MODEL;
  const topK = config?.configurable?.topK || 5;
  const maxContextTokens = config?.configurable?.maxContextTokens || 8000;

  let thread = await Thread.findOne({ where: { thread_id: thread_id } });
  if (!thread) {
    thread = await Thread.create({
      thread_id: thread_id,
      status: 'idle',
      messages: []
    });
    console.log('[runs/stream] 创建新 Thread:', thread_id);
  }

  const runId = uuidv4();
  await Run.create({
    run_id: runId,
    thread_id: thread_id,
    assistant_id: assistant_id || 'rag-assistant',
    status: 'running',
    input: { messages: input?.messages }
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`event: run_created\ndata: ${JSON.stringify({ run_id: runId, thread_id, assistant_id, status: 'running' })}\n\n`);

  try {
    console.log('检索知识库...');
    const retrieveResult = await ragService.retrieve({
      query: userMessage,
      denseSimilarityTopK: topK,
      sparseSimilarityTopK: topK,
      enableReranking: true,
      rerankTopN: topK
    });

    let contextDocs = retrieveResult.nodes || [];
    console.log(`检索到 ${contextDocs.length} 个相关文档`);

    if (attachmentDocs && attachmentDocs.length > 0) {
      console.log('[runs/stream] 处理附件文档:', attachmentDocs.length, '个');

      const attachmentContextDocs = attachmentDocs.map(doc => {
        console.log('[runs/stream] 附件文档:', doc.fileName, '文本长度:', doc.textContent?.length);
        return {
          text: doc.textContent || doc.content || '',
          docName: doc.fileName || '附件',
          docId: 'attachment',
          score: 1.0,
          source: 'attachment'
        };
      });

      contextDocs = [...attachmentContextDocs, ...contextDocs];
      console.log('[runs/stream] 合并附件文档后，总计', contextDocs.length, '个文档');
    }

    res.write(`event: sources\ndata: ${JSON.stringify({
      sources: contextDocs.slice(0, 5).map(doc => ({
        docName: doc.docName,
        score: doc.score,
        source: doc.source || 'knowledge'
      })),
      run_id: runId
    })}\n\n`);

    const generator = langchainService.enhancedRagChatStreamGenerator(
      userMessage,
      thread_id,
      contextDocs,
      { model, temperature: 0.7, maxContextTokens, tools: allTools }
    );

    let fullResponse = '';
    let interrupted = false;

    for await (const chunk of generator) {
      if (chunk.type === 'interrupt') {
        interrupted = true;
        await Run.update(
          { status: 'awaiting_approval', interrupt_data: JSON.stringify(chunk) },
          { where: { run_id: runId } }
        );
        res.write(`event: interrupt\ndata: ${JSON.stringify({
          type: 'interrupt',
          actionRequests: chunk.actionRequests,
          reviewConfigs: chunk.reviewConfigs,
          thread_id: thread_id,
          run_id: runId
        })}\n\n`);
        break;
      }

      if (chunk.type === 'text') {
        fullResponse += chunk.content;
      }

      res.write(`event: message\ndata: ${JSON.stringify({
        ...chunk,
        run_id: runId
      })}\n\n`);
    }

    if (interrupted) {
      res.end();
      return;
    }

    await Run.update(
      { status: 'completed', output: fullResponse },
      { where: { run_id: runId } }
    );

    thread = await Thread.findOne({ where: { thread_id: thread_id } });

    res.write(`event: run_completed\ndata: ${JSON.stringify({
      run_id: runId,
      thread_id,
      status: 'completed',
      result: {
        messages: thread.messages || []
      }
    })}\n\n`);

  } catch (error) {
    console.error('RAG stream error:', error);

    await Run.update(
      { status: 'error', error_message: error.message },
      { where: { run_id: runId } }
    );

    res.write(`event: error\ndata: ${JSON.stringify({
      run_id: runId,
      thread_id,
      error: error.message
    })}\n\n`);
  }

  res.end();
};

// HITL 恢复端点
const resumeStreamHandler = async (req, res) => {
  const { thread_id, decisions } = req.body;

  if (!thread_id || !decisions || !Array.isArray(decisions)) {
    return res.status(400).json({
      success: false,
      message: 'thread_id 和 decisions 数组为必填项'
    });
  }

  console.log('[resume] 恢复会话:', thread_id, 'decisions:', JSON.stringify(decisions));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const model = req.body.model || DASHSCOPE_MODEL;

  try {
    const generator = langchainService.resumeStreamGenerator(
      thread_id,
      decisions,
      { model, temperature: 0.7, tools: allTools }
    );

    let fullResponse = '';

    for await (const chunk of generator) {
      if (chunk.type === 'interrupt') {
        res.write(`event: interrupt\ndata: ${JSON.stringify({
          type: 'interrupt',
          actionRequests: chunk.actionRequests,
          reviewConfigs: chunk.reviewConfigs,
          thread_id: thread_id
        })}\n\n`);
        res.end();
        return;
      }

      if (chunk.type === 'text') {
        fullResponse += chunk.content;
      }

      res.write(`event: message\ndata: ${JSON.stringify(chunk)}\n\n`);
    }

    const pendingRun = await Run.findOne({
      where: { thread_id, status: 'awaiting_approval' },
      order: [['created_at', 'DESC']]
    });
    if (pendingRun) {
      await pendingRun.update({ status: 'completed', output: fullResponse });
    }

    const thread = await Thread.findOne({ where: { thread_id } });

    res.write(`event: run_completed\ndata: ${JSON.stringify({
      thread_id,
      status: 'completed',
      result: {
        messages: thread?.messages || []
      }
    })}\n\n`);

  } catch (error) {
    console.error('[resume] 错误:', error.message);
    res.write(`event: error\ndata: ${JSON.stringify({
      thread_id,
      error: error.message
    })}\n\n`);
  }

  res.end();
};

// ========== 推荐回答生成（SSE 流式，无 checkpoint）==========
/**
 * POST /api/v1/messages/:msgId/suggestions
 *
 * 根据用户消息生成推荐回复（SSE 流式输出）
 * - 上下文从 plat_messages 表手动查询，不使用 LangGraph checkpoint
 * - 可多次调用生成不同推荐，不影响会话持久化
 * - 只有客服实际发送的消息才会入库（sendOutboundMessage）
 */
const suggestionFeedbackHandler = async (req, res) => {
  const { msgId } = req.params;
  const { answer, answerCn, customerLang = 'zh', model, feedback = 'none', feedbackNote = '', sources = [] } = req.body || {};

  if (!answer || !String(answer).trim()) {
    return res.status(400).json({ success: false, message: '推荐回答不能为空' });
  }
  if (!['none', 'up', 'down'].includes(feedback)) {
    return res.status(400).json({ success: false, message: 'feedback 仅支持 none/up/down' });
  }

  try {
    const { sequelize } = require('../../config/database');
    const [msgRows] = await sequelize.query(
      `SELECT pm.id, pm.conversation_id, pm.channel, pm.account_id, pm.user_id, pm.content,
              DATE_FORMAT(pm.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              pm.direction, pm.sender_type, pm.message_type,
              c.user_name,
              ca.knowledge_scope AS account_knowledge_scope,
              ca.knowledge_channels AS account_knowledge_channels
       FROM plat_messages pm
       LEFT JOIN conversations c ON pm.conversation_id = c.id
       LEFT JOIN channel_accounts ca ON pm.account_id = ca.id
       WHERE pm.id = :msgId LIMIT 1`,
      { replacements: { msgId } }
    );
    if (msgRows.length === 0) {
      return res.status(404).json({ success: false, message: '消息不存在' });
    }

    const msg = msgRows[0];
    const feedbackContext = await buildSuggestionFeedbackContext(sequelize, msg);
    const knowledgeMetadata = normalizeKnowledgeMetadata({
      knowledgeScope: req.body?.knowledgeScope || req.body?.knowledge_scope || msg.account_knowledge_scope,
      knowledgeChannels: req.body?.knowledgeChannels || req.body?.knowledge_channels || msg.account_knowledge_channels
    }, msg.channel);

    const operatorId = req.user?.id || req.user?.userId || null;
    const recordId = crypto.randomUUID();
    await sequelize.query(
      `INSERT INTO ai_suggest_qa_records
        (id, conversation_id, message_id, channel, account_id, user_id, question, answer, answer_cn,
         knowledge_scope, knowledge_channels, customer_lang, model, feedback, feedback_note, sources, context_messages, created_by, updated_by, status, created_at, updated_at)
       VALUES
        (:recordId, :conversationId, :messageId, :channel, :accountId, :userId, :question, :answer, :answerCn,
         :knowledgeScope, :knowledgeChannels, :customerLang, :model, :feedback, :feedbackNote, :sources, :contextMessages, :operatorId, :operatorId, 'pending', NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         question = VALUES(question),
         answer_cn = VALUES(answer_cn),
         knowledge_scope = VALUES(knowledge_scope),
         knowledge_channels = VALUES(knowledge_channels),
         customer_lang = VALUES(customer_lang),
         model = VALUES(model),
         feedback = VALUES(feedback),
         feedback_note = VALUES(feedback_note),
         sources = VALUES(sources),
         context_messages = VALUES(context_messages),
         updated_by = VALUES(updated_by),
         updated_at = NOW()`,
      {
        replacements: {
          recordId,
          conversationId: msg.conversation_id,
          messageId: msg.id,
          channel: msg.channel,
          accountId: msg.account_id,
          userId: msg.user_id,
          question: feedbackContext.question,
          answer: String(answer).trim(),
          answerCn: answerCn ? String(answerCn).trim() : null,
          knowledgeScope: knowledgeMetadata.knowledgeScope,
          knowledgeChannels: JSON.stringify(knowledgeMetadata.knowledgeChannels),
          customerLang,
          model: model || null,
          feedback,
          feedbackNote: feedbackNote || null,
          sources: JSON.stringify(sources || []),
          contextMessages: JSON.stringify(feedbackContext.contextMessages || []),
          operatorId
        }
      }
    );

    const [rows] = await sequelize.query(
      `SELECT * FROM ai_suggest_qa_records WHERE message_id = :msgId AND answer = :answer LIMIT 1`,
      { replacements: { msgId, answer: String(answer).trim() } }
    );

    res.json({ success: true, message: '反馈已记录', data: rows[0] || null });
  } catch (error) {
    console.error('[QAFeedback] 保存失败:', error.message);
    res.status(500).json({ success: false, message: '保存失败: ' + error.message });
  }
};

const qaRecordsListHandler = async (req, res) => {
  try {
    const { sequelize } = require('../../config/database');
    const { feedback, status, q, page = 1, pageSize = 20 } = req.query;
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;
    const conditions = [];
    const replacements = { limit, offset };

    if (feedback && feedback !== 'all') {
      conditions.push('r.feedback = :feedback');
      replacements.feedback = feedback;
    }
    if (status && status !== 'all') {
      conditions.push('r.status = :status');
      replacements.status = status;
    }
    if (q && q.trim()) {
      conditions.push('(r.question LIKE :q OR r.answer LIKE :q OR r.answer_cn LIKE :q OR r.user_id LIKE :q)');
      replacements.q = `%${q.trim()}%`;
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await sequelize.query(
      `SELECT r.id, r.conversation_id, r.message_id, r.channel, r.account_id, r.user_id,
              r.question, r.answer, r.answer_cn, r.knowledge_scope, r.knowledge_channels, r.customer_lang, r.model, r.feedback,
              r.feedback_note, r.sources, r.context_messages, r.created_by, r.updated_by, r.status,
              r.created_at, r.updated_at,
              c.user_name, ca.account_name, u.username AS created_by_name, uu.username AS updated_by_name
       FROM ai_suggest_qa_records r
       LEFT JOIN conversations c ON r.conversation_id = c.id
       LEFT JOIN channel_accounts ca ON r.account_id = ca.id
       LEFT JOIN users u ON r.created_by = u.id
       LEFT JOIN users uu ON r.updated_by = uu.id
       ${whereClause}
       ORDER BY r.updated_at DESC
       LIMIT :limit OFFSET :offset`,
      { replacements }
    );
    const [countRows] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM ai_suggest_qa_records r ${whereClause}`,
      { replacements }
    );

    res.json({
      success: true,
      data: {
        list: rows.map(row => {
          const knowledgeMetadata = normalizeKnowledgeMetadata({
            knowledgeScope: row.knowledge_scope,
            knowledgeChannels: row.knowledge_channels
          }, row.channel);
          return {
            ...row,
            knowledgeScope: knowledgeMetadata.knowledgeScope,
            knowledgeChannels: knowledgeMetadata.knowledgeChannels,
            sources: typeof row.sources === 'string' ? safeJsonParse(row.sources, []) : (row.sources || []),
            contextMessages: typeof row.context_messages === 'string'
              ? safeJsonParse(row.context_messages, [])
              : (row.context_messages || [])
          };
        }),
        total: countRows[0]?.total || 0,
        page: parseInt(page) || 1,
        pageSize: limit
      }
    });
  } catch (error) {
    console.error('[QARecords] 查询失败:', error.message);
    res.status(500).json({ success: false, message: '查询失败: ' + error.message });
  }
};

const updateQaRecordHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, feedbackNote, knowledgeScope, knowledgeChannels } = req.body || {};
    const validStatus = ['pending', 'accepted', 'rejected', 'exported'];
    if (status && !validStatus.includes(status)) {
      return res.status(400).json({ success: false, message: '无效状态' });
    }
    const operatorId = req.user?.id || req.user?.userId || null;
    const updates = [];
    const replacements = { id, operatorId };
    if (status) {
      updates.push('status = :status');
      replacements.status = status;
    }
    if (feedbackNote !== undefined) {
      updates.push('feedback_note = :feedbackNote');
      replacements.feedbackNote = feedbackNote || null;
    }
    if (knowledgeScope !== undefined || knowledgeChannels !== undefined) {
      const knowledgeMetadata = normalizeKnowledgeMetadata({ knowledgeScope, knowledgeChannels });
      updates.push('knowledge_scope = :knowledgeScope', 'knowledge_channels = :knowledgeChannels');
      replacements.knowledgeScope = knowledgeMetadata.knowledgeScope;
      replacements.knowledgeChannels = JSON.stringify(knowledgeMetadata.knowledgeChannels);
    }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: '没有可更新字段' });
    }
    updates.push('updated_by = :operatorId', 'updated_at = NOW()');
    const { sequelize } = require('../../config/database');
    await sequelize.query(`UPDATE ai_suggest_qa_records SET ${updates.join(', ')} WHERE id = :id`, { replacements });
    res.json({ success: true, message: '已更新' });
  } catch (error) {
    console.error('[QARecords] 更新失败:', error.message);
    res.status(500).json({ success: false, message: '更新失败: ' + error.message });
  }
};

const deleteQaRecordHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const { sequelize } = require('../../config/database');
    const [rows] = await sequelize.query(
      'SELECT id FROM ai_suggest_qa_records WHERE id = :id LIMIT 1',
      { replacements: { id } }
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'QA 记录不存在' });
    }
    await sequelize.query(
      'DELETE FROM ai_suggest_qa_records WHERE id = :id',
      { replacements: { id } }
    );
    res.json({ success: true, message: '已删除' });
  } catch (error) {
    console.error('[QARecords] 删除失败:', error.message);
    res.status(500).json({ success: false, message: '删除失败: ' + error.message });
  }
};

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

const suggestionStreamHandler = async (req, res) => {
  const { msgId } = req.params;
  const { regenerate = false, model, temperature, topK = 5 } = req.body || {};

  console.log('[Suggestion] 生成推荐，msgId:', msgId, 'regenerate:', regenerate);

  try {
    // 0. 请求去重（非 regenerate 请求才检查）
    if (!regenerate) {
      const cached = checkDedup(msgId);
      if (cached) {
        if (cached.state === 'done' && cached.result) {
          // 命中缓存 → 直接返回完整结果；同时做一次语言兜底，避免旧缓存保留错误语言结果
          console.log('[Suggestion] 命中去重缓存，msgId:', msgId);
          let cachedSuggestion = cached.result.suggestion || '';
          let cachedSuggestionCn = cached.result.suggestionCn || '';
          if (cached.result.customerLang === 'zh') {
            if (cachedSuggestionCn && looksChinese(cachedSuggestionCn)) {
              cachedSuggestion = cachedSuggestionCn;
              cachedSuggestionCn = '';
            } else if (cachedSuggestion && !looksChinese(cachedSuggestion)) {
              cachedSuggestion = await translateSuggestionText(cachedSuggestion, '简体中文');
              cachedSuggestionCn = '';
            }
          } else if (cached.result.customerLang === 'other' && cachedSuggestion && !cachedSuggestionCn) {
            cachedSuggestionCn = await translateSuggestionText(cachedSuggestion, '简体中文');
          }
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.write(`event: done\ndata: ${JSON.stringify({
            msgId,
            suggestion: cachedSuggestion,
            suggestionCn: cachedSuggestionCn || null,
            customerLang: cached.result.customerLang,
            cached: true,
            regenerated: false
          })}\n\n`);
          return res.end();
        }
        if (cached.state === 'generating') {
          // 正在生成中 → 返回 409
          return res.status(409).json({ success: false, message: '正在生成中，请稍候', msgId });
        }
      }
      startDedup(msgId);
    }

    // 1. 查询消息内容
    const { sequelize } = require('../../config/database');
    const [msgRows] = await sequelize.query(
      `SELECT pm.id, pm.conversation_id, pm.channel, pm.account_id, pm.direction, pm.message_type, pm.content,
              ca.knowledge_scope AS account_knowledge_scope,
              ca.knowledge_channels AS account_knowledge_channels
       FROM plat_messages pm
       LEFT JOIN channel_accounts ca ON pm.account_id = ca.id
       WHERE pm.id = :msgId LIMIT 1`,
      { replacements: { msgId } }
    );

    if (msgRows.length === 0) {
      if (!regenerate) clearDedup(msgId);
      return res.status(404).json({ success: false, message: '消息不存在' });
    }

    const msg = msgRows[0];

    // 解析消息文本
    // 重构完成后 content.text 就是客户原文，content.translatedText 是中文译文
    let queryText = '';
    let currentRetrievalText = '';
    try {
      const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      queryText = content.text || content.content || JSON.stringify(content);
      currentRetrievalText = buildRetrievalText(queryText, content.translatedText || '');
    } catch {
      queryText = typeof msg.content === 'string' ? msg.content : '';
      currentRetrievalText = queryText;
    }

    if (!queryText) {
      if (!regenerate) clearDedup(msgId);
      return res.status(400).json({ success: false, message: '消息内容为空，无法生成推荐' });
    }

    // 用于 LLM 的文本就是原文（content.text 重构后不再被译文覆盖）
    const llmInputText = queryText;

    // 检测客户语言（永远以当前这条消息的原文为准）
    // 优先用 originalLang 字段（入库时已检测），没有则用 CJK 占比兜底
    let customerLang = 'zh';
    try {
      const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      if (content.originalLang && content.originalLang !== 'zh' && content.originalLang !== 'unknown') {
        customerLang = 'other';
      }
    } catch { /* 兜底用 CJK 检测 */ }
    if (customerLang === 'zh') {
      const cjkCount = (llmInputText.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
      const totalChars = llmInputText.replace(/\s/g, '').length;
      if (totalChars > 0 && cjkCount / totalChars < 0.3) {
        customerLang = 'other';
      }
    }
    console.log('[Suggestion] 客户语言检测:', customerLang);

    // 2. 获取会话上下文（从 plat_messages 手动查询）
    const rawLlmContextCount = await configService.getConfig('llm_context_message_count');
    const parsedLlmContextCount = parseInt(rawLlmContextCount, 10);
    const llmContextCount = Number.isFinite(parsedLlmContextCount)
      ? Math.max(0, Math.min(parsedLlmContextCount, 50))
      : 20;
    const history = await messagingService.getConversationContext(msg.conversation_id, llmContextCount);
    console.log('[Suggestion] 会话上下文消息数:', history.length, '(配置:', llmContextCount, ')');

    // 2.5 构建增强检索 query
    // rag_context_message_count:
    //   0 = 智能检测模式（仅短消息/代词时拼接最近3条客户消息）
    //   >0 = 总是拼接最近 N 条客户消息作为 RAG 检索 query
    const ragContextCount = Math.max(0, Math.min(parseInt(await configService.getConfig('rag_context_message_count'), 10) || 0, 10));
    const baseRetrieveText = currentRetrievalText || llmInputText;
    let retrieveQuery = baseRetrieveText;
    const retrievalHistoryLimit = ragContextCount > 0 ? ragContextCount : 3;
    const retrievalHistory = await getRecentCustomerRetrievalTexts(msg.conversation_id, retrievalHistoryLimit);
    if (ragContextCount === 0) {
      // 智能检测：短消息或含代词时自动拼接
      const shortOrAmbiguous = llmInputText.length < 30 || /\b(it|this|that|the other|the (first|second|small|big) one|another)\b/i.test(llmInputText);
      if (shortOrAmbiguous && retrievalHistory.length > 0) {
        const recentUserMsgs = retrievalHistory.slice(-3);
        recentUserMsgs.push(baseRetrieveText);
        retrieveQuery = recentUserMsgs.join(' ');
        console.log('[Suggestion] 智能检测：短/代词消息，使用增强检索 query，长度:', retrieveQuery.length);
      }
    } else if (ragContextCount > 0 && retrievalHistory.length > 0) {
      // 固定拼接模式：总是拼接最近 N 条客户消息
      const recentUserMsgs = retrievalHistory.slice(-ragContextCount);
      recentUserMsgs.push(baseRetrieveText);
      retrieveQuery = recentUserMsgs.join(' ');
      console.log('[Suggestion] 固定拼接模式：拼接', ragContextCount, '条客户消息，检索 query长度:', retrieveQuery.length);
    }

    // 3. 检索知识库（使用增强 query 搜索能得到更好的匹配结果）
    const retrieveResult = await ragService.retrieve({
      query: retrieveQuery,
      denseSimilarityTopK: topK,
      sparseSimilarityTopK: topK,
      enableReranking: true,
      rerankTopN: topK,
      channel: msg.channel,
      knowledgeScope: msg.account_knowledge_scope,
      knowledgeChannels: msg.account_knowledge_channels
    });
    const contextDocs = retrieveResult.nodes || [];
    console.log('[Suggestion] 检索到', contextDocs.length, '个相关文档');

    // 4. SSE 流式输出
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 推送检索来源
    res.write(`event: sources\ndata: ${JSON.stringify({
      sources: contextDocs.slice(0, 5).map(doc => ({
        docName: doc.docName,
        score: doc.score,
        source: doc.source || 'knowledge',
        knowledgeScope: doc.knowledgeScope,
        knowledgeChannels: doc.knowledgeChannels
      })),
      msgId
    })}\n\n`);

    // 5. 从配置读取默认模型（非 regenerate 时用配置的默认模型）
    const defaultSuggestModel = await configService.getConfig('ai_suggest_model') || DASHSCOPE_MODEL;
    const useModel = model || defaultSuggestModel;

    // 6. 通过限流器调用推荐生成器（限流器包裹整个生成+流式写入过程）
    let fullResponse = '';
    let chineseVersion = '';
    let genError = null;

    await suggestionLimiter(async () => {
      const generator = langchainService.generateRecommendationStream(
        llmInputText,
        history,
        contextDocs,
        { model: useModel, temperature: temperature ?? 0.7, maxContextTokens: 4000, customerLang }
      );

      for await (const chunk of generator) {
        if (chunk.type === 'error') {
          genError = chunk;
          return;
        }
        if (chunk.type === 'text') {
          fullResponse += chunk.content;
        }
        if (chunk.type === 'cn_version') {
          chineseVersion = chunk.content;
        }
        res.write(`event: message\ndata: ${JSON.stringify({ ...chunk, msgId })}\n\n`);
      }
    });

    // 生成器内部错误
    if (genError) {
      console.error('[Suggestion] 推荐生成器错误:', genError.message);
      if (!regenerate) clearDedup(msgId);
      res.write(`event: error\ndata: ${JSON.stringify({ msgId, error: genError.message || '生成失败' })}\n\n`);
      res.end();
      return;
    }

    // 7. 输出安全 + 语言兜底校验
    // 提示词已经强约束当前消息语言，但模型仍可能被历史上下文语言带偏。
    // done 事件会覆盖前端流式累积文本，因此这里可在结束前修正最终展示/采纳内容。
    const sanitizedResponse = sanitizeCustomerOutputText(fullResponse);
    if (sanitizedResponse !== fullResponse.trim()) {
      console.warn('[Suggestion] 推荐结果包含内部来源标记，已自动清理');
      fullResponse = sanitizedResponse;
    }
    const sanitizedChineseVersion = sanitizeCustomerOutputText(chineseVersion);
    if (sanitizedChineseVersion !== chineseVersion.trim()) {
      console.warn('[Suggestion] 推荐中文译文包含内部来源标记，已自动清理');
      chineseVersion = sanitizedChineseVersion;
    }

    if (customerLang === 'zh') {
      if (chineseVersion && looksChinese(chineseVersion)) {
        console.warn('[Suggestion] 中文客户生成了双语分隔内容，使用中文版本作为最终推荐');
        fullResponse = chineseVersion;
        chineseVersion = '';
      } else if (fullResponse && !looksChinese(fullResponse)) {
        console.warn('[Suggestion] 中文客户推荐结果非中文，执行兜底翻译为中文');
        fullResponse = await translateSuggestionText(fullResponse, '简体中文');
        chineseVersion = '';
      }
    } else if (customerLang === 'other' && fullResponse && !chineseVersion) {
      console.warn('[Suggestion] 非中文客户推荐缺少中文版本，执行兜底翻译');
      chineseVersion = await translateSuggestionText(fullResponse, '简体中文');
    }

    fullResponse = sanitizeCustomerOutputText(fullResponse);
    chineseVersion = sanitizeCustomerOutputText(chineseVersion);

    // 8. 立即推送 done 事件（含中文版本）+ 立即 res.end() 释放 SSE 连接
    const donePayload = {
      msgId,
      suggestion: fullResponse,
      suggestionCn: chineseVersion || null,
      customerLang,
      regenerated: regenerate
    };
    res.write(`event: done\ndata: ${JSON.stringify(donePayload)}\n\n`);

    // 缓存结果（非 regenerate）
    if (!regenerate) {
      completeDedup(msgId, { suggestion: fullResponse, suggestionCn: chineseVersion, customerLang });
    }

  } catch (error) {
    console.error('[Suggestion] 生成失败:', error.message);
    if (!regenerate) clearDedup(msgId);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: error.message });
    }
    res.write(`event: error\ndata: ${JSON.stringify({ msgId, error: error.message })}\n\n`);
  }

  res.end();
};

// ========== 路由注册 ==========

// 聊天（原 /api/chat）
router.post('/chat/send', controller.sendMessage);

// 聊天附件（原 /api/chat/attachment）
router.post('/chat/attachment/upload', chatAttachmentUpload.single('file'), controller.uploadAttachment);
router.post('/chat/attachment/upload-batch', chatAttachmentUpload.array('files', 5), controller.uploadBatchAttachments);

// 知识库（原 /api/knowledge）
router.get('/knowledge/documents', controller.listDocuments);
router.post('/knowledge/documents/delete', controller.deleteDocuments);
router.get('/knowledge/documents/detail', controller.describeDocument);
router.get('/knowledge/documents/chunks', controller.listDocumentChunks);
router.get('/knowledge/documents/download', requireKnowledgeManageRole, controller.downloadDocument);

// LangChain（原 /api/langchain）
router.get('/langchain/webapp/models', controller.getModels);
router.get('/langchain/assistants', controller.getAssistants);
router.post('/langchain/threads', controller.createThread);
router.get('/langchain/threads', controller.listThreads);
router.get('/langchain/threads/:threadId/state', controller.getThreadState);
router.delete('/langchain/threads/:threadId', controller.deleteThread);
router.post('/langchain/runs/stream', streamRunHandler);
router.post('/langchain/runs/stream/resume', resumeStreamHandler);
router.post('/langchain/runs/:runId/cancel', controller.cancelRun);
router.post('/langchain/chain/process', controller.processChain);

// 百炼上传（原 /api/upload）
router.post('/upload/upload', bailianUpload.single('file'), controller.uploadSingle);
router.post('/upload/upload-batch', bailianUpload.array('files', 10), controller.uploadBatch);

// 本地解析上传（原 /api/local）
router.post('/local/upload-to-bailian', localUpload.single('file'), controller.uploadToBailian);
router.post('/local/upload-to-bailian-batch', localUpload.array('files', 10), controller.uploadToBailianBatch);
router.post('/local/preview-chunks', localUpload.single('file'), controller.previewChunks);
router.post('/local/confirm-upload', controller.confirmUpload);

// 模板（原 /api/template）
router.get('/template/list', controller.listTemplates);
router.get('/template/detail/:templateId', controller.getTemplate);
router.get('/template/default', controller.getDefaultTemplate);
router.post('/template/create', controller.createTemplate);
router.post('/template/update/:templateId', controller.updateTemplate);
router.post('/template/delete/:templateId', controller.deleteTemplate);
router.post('/template/set-default/:templateId', controller.setDefaultTemplate);
router.post('/template/init', controller.initTemplatesTable);

// 管理（原 /api/admin）
router.use('/admin', createLegacyAdminRouter({ controller }));

// 推荐回答生成（聚合平台专用，无 checkpoint，手动上下文）
router.post('/v1/messages/:msgId/suggestions', suggestionStreamHandler);
// 推荐回答点赞/点踩反馈，沉淀为 QA 记录
router.post('/v1/messages/:msgId/suggestion-feedback', (req, res, next) => {
  req.user = optionalJwtUser(req);
  next();
}, suggestionFeedbackHandler);
// QA 记录列表（后台知识库维护使用）
router.get('/v1/qa-records', requireQaRecordRole, qaRecordsListHandler);
router.patch('/v1/qa-records/:id', requireQaRecordRole, updateQaRecordHandler);
router.delete('/v1/qa-records/:id', requireQaRecordRole, deleteQaRecordHandler);

module.exports = router;
