const ragService = require('./ragService');
const langchainService = require('./langchainService');
const localParserService = require('./localParserService');
const templateService = require('./templateService');
const { allTools } = require('./tools');
const { Thread, Run, Document, User } = require('../../models');
const { SeatAccountBinding, ChannelAccount, SeatSkillTag } = require('../../models');
const path = require('path');
const fs = require('fs');
const documentSourceService = require('./documentSourceService');
const { normalizeKnowledgeMetadata } = require('./knowledgeScope');

// 环境变量配置
const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus';

// ========== chatController ==========

const sendMessage = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: '消息内容不能为空'
      });
    }

    const answer = await ragService.getAnswer(message);

    res.json({
      success: true,
      message: '发送成功',
      data: { answer }
    });
  } catch (error) {
    console.error('发送消息失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '发送消息失败'
    });
  }
};

// ========== knowledgeController ==========

const listDocuments = async (req, res) => {
  try {
    const { pageSize, pageNumber, documentName, documentStatus, aggregateLocalChunks } = req.query;

    const shouldAggregateLocalChunks = aggregateLocalChunks === true || aggregateLocalChunks === 'true';
    const requestedPageSize = pageSize ? parseInt(pageSize) : 50;
    const requestedPageNumber = pageNumber ? parseInt(pageNumber) : 1;

    const result = shouldAggregateLocalChunks
      ? await listAggregatedLocalDocuments({
          pageSize: requestedPageSize,
          pageNumber: requestedPageNumber,
          documentName,
          documentStatus
        })
      : await ragService.listDocuments({
          pageSize: requestedPageSize,
          pageNumber: requestedPageNumber,
          documentName,
          documentStatus
        });

    if (!shouldAggregateLocalChunks) {
      result.documents = await documentSourceService.attachDownloadAvailability(result.documents || []);
    }

    res.json({
      success: true,
      message: '查询成功',
      data: result
    });
  } catch (error) {
    console.error('查询文档列表失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '查询文档列表失败'
    });
  }
};

function parseLocalChunkFileName(fileName = '') {
  const match = String(fileName).match(/^(.*)_chunk_(\d+)(?:\.txt)?$/i);
  if (!match) return null;
  return {
    baseName: match[1],
    index: Number(match[2]) || 0
  };
}

function sameChannelsKey(channels = []) {
  const normalized = Array.isArray(channels) && channels.length ? channels : ['all'];
  return [...normalized].sort().join(',');
}

async function listAllBailianDocuments({ documentName, documentStatus } = {}) {
  const allDocuments = [];
  let pageNumber = 1;
  const pageSize = 100;
  let totalCount = 0;
  let lastResult = null;
  const maxPages = 100;

  while (pageNumber <= maxPages) {
    const result = await ragService.listDocuments({
      pageSize,
      pageNumber,
      documentName,
      documentStatus
    });
    lastResult = result;
    const documents = result.documents || [];
    totalCount = Number(result.totalCount) || allDocuments.length + documents.length;
    allDocuments.push(...documents);
    if (documents.length === 0 || allDocuments.length >= totalCount) break;
    pageNumber += 1;
  }

  return {
    documents: allDocuments,
    totalCount,
    indexId: lastResult?.indexId,
    rawIncomplete: totalCount > allDocuments.length
  };
}

function aggregateLocalChunkDocuments(documents = []) {
  const groups = new Map();
  const result = [];

  for (const doc of documents) {
    const chunkInfo = parseLocalChunkFileName(doc.fileName);
    if (!chunkInfo) {
      result.push({
        ...doc,
        displayFileName: doc.fileName,
        documentIds: doc.documentId ? [doc.documentId] : [],
        chunkDocuments: [doc],
        chunkCount: 1
      });
      continue;
    }

    const scope = doc.knowledgeScope || 'overseas';
    const channels = Array.isArray(doc.knowledgeChannels) && doc.knowledgeChannels.length ? doc.knowledgeChannels : ['all'];
    const groupKey = doc.sourceArchiveId || `${scope}::${sameChannelsKey(channels)}::${chunkInfo.baseName}`;

    if (!groups.has(groupKey)) {
      const sourceOriginalName = doc.sourceOriginalName || null;
      const group = {
        ...doc,
        fileName: sourceOriginalName || doc.fileName,
        displayFileName: `${chunkInfo.baseName}（本地解析）`,
        documentIds: [],
        chunkDocuments: [],
        chunkCount: 0,
        isChunkGroup: true,
        fileType: sourceOriginalName ? path.extname(sourceOriginalName).replace('.', '').toLowerCase() || 'txt' : 'txt',
        size: Number(doc.sourceSize) || 0,
        sourceOriginalName,
        knowledgeScope: scope,
        knowledgeChannels: channels
      };
      groups.set(groupKey, group);
      result.push(group);
    }

    const group = groups.get(groupKey);
    group.documentIds.push(doc.documentId);
    group.chunkDocuments.push({ ...doc, chunkIndex: chunkInfo.index });
    group.chunkCount += 1;
    if (!group.sourceSize) {
      group.size += Number(doc.size) || 0;
    }
    group.downloadAvailable = group.downloadAvailable || doc.downloadAvailable;
    if (new Date(doc.gmtModified || 0) > new Date(group.gmtModified || 0)) {
      group.gmtModified = doc.gmtModified;
    }
    if (doc.status !== 'FINISH') {
      group.status = doc.status;
    }
  }

  for (const item of result) {
    if (item.isChunkGroup) {
      item.chunkDocuments.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
      item.documentId = item.documentIds[0];
      if (!item.size) {
        item.size = item.chunkDocuments.reduce((sum, doc) => sum + (Number(doc.size) || 0), 0);
      }
    }
  }

  return result;
}

async function listAggregatedLocalDocuments({ pageSize = 50, pageNumber = 1, documentName, documentStatus } = {}) {
  const rawResult = await listAllBailianDocuments({ documentName, documentStatus });
  const documentsWithSources = await documentSourceService.attachDownloadAvailability(rawResult.documents || []);
  const aggregatedDocuments = aggregateLocalChunkDocuments(documentsWithSources);
  const normalizedPageSize = Math.max(1, Number(pageSize) || 50);
  const normalizedPageNumber = Math.max(1, Number(pageNumber) || 1);
  const start = (normalizedPageNumber - 1) * normalizedPageSize;

  return {
    documents: aggregatedDocuments.slice(start, start + normalizedPageSize),
    totalCount: aggregatedDocuments.length,
    rawTotalCount: rawResult.totalCount,
    rawIncomplete: rawResult.rawIncomplete,
    pageNumber: normalizedPageNumber,
    pageSize: normalizedPageSize,
    indexId: rawResult.indexId
  };
}

const deleteDocuments = async (req, res) => {
  try {
    const { documentId, documentIds } = req.body;

    const ids = documentIds || (documentId ? [documentId] : []);

    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: '缺少documentId或documentIds参数'
      });
    }

    const result = await ragService.deleteIndexDocument(ids);

    res.json({
      success: true,
      message: '删除成功',
      data: result
    });
  } catch (error) {
    console.error('删除文档失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '删除文档失败'
    });
  }
};

const describeDocument = async (req, res) => {
  try {
    const { fileId } = req.query;

    if (!fileId) {
      return res.status(400).json({
        success: false,
        message: '缺少fileId参数'
      });
    }

    const result = await ragService.describeDocument(fileId);

    res.json({
      success: true,
      message: '查询成功',
      data: result
    });
  } catch (error) {
    console.error('查询文档详情失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '查询文档详情失败'
    });
  }
};

const listDocumentChunks = async (req, res) => {
  try {
    const { fileId } = req.query;
    const pageNum = parseInt(req.query.pageNum) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;

    if (!fileId) {
      return res.status(400).json({
        success: false,
        message: '缺少fileId参数'
      });
    }

    const result = await ragService.listDocumentChunks(fileId, pageNum, pageSize);

    res.json({
      success: true,
      message: '查询成功',
      data: result
    });
  } catch (error) {
    console.error('查询文档切片失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '查询文档切片失败'
    });
  }
};

const downloadDocument = async (req, res) => {
  try {
    const { documentId, fileId, fileName, size } = req.query;

    if (!documentId && !fileId && !fileName) {
      return res.status(400).json({
        success: false,
        message: '缺少documentId、fileId或fileName参数'
      });
    }

    const source = await documentSourceService.findSource({
      documentId,
      fileId,
      fileName,
      size
    });
    const downloadPath = source ? documentSourceService.resolveDownloadPath(source) : null;

    if (!source || !downloadPath) {
      return res.status(404).json({
        success: false,
        message: '未找到该文档的本地源文件。历史文档若上传时未留存源文件，需要重新上传后才可下载。'
      });
    }

    res.download(downloadPath, source.original_name, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ success: false, message: '下载失败: ' + err.message });
      }
    });
  } catch (error) {
    console.error('下载文档失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '下载文档失败'
    });
  }
};

// ========== langchainController ==========

const getModels = async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        models: [
          {
            id: 'qwen-plus',
            name: '通义千问 Plus',
            description: '阿里云百炼大模型，适合复杂问答',
            provider: 'dashscope'
          },
          {
            id: 'qwen-turbo',
            name: '通义千问 Turbo',
            description: '阿里云百炼大模型，响应更快',
            provider: 'dashscope'
          },
          {
            id: 'qwen-max',
            name: '通义千问 Max',
            description: '阿里云百炼大模型，最强能力',
            provider: 'dashscope'
          }
        ]
      }
    });
  } catch (error) {
    console.error('获取模型列表失败:', error.message);
    res.status(500).json({
      success: false,
      message: '获取模型列表失败'
    });
  }
};

const getAssistants = async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        assistants: [
          {
            assistant_id: 'rag-assistant',
            name: 'RAG智能客服',
            description: '基于知识库的智能问答助手',
            config: {
              configurable: {
                model: DASHSCOPE_MODEL
              }
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('获取assistants列表失败:', error.message);
    res.status(500).json({
      success: false,
      message: '获取助手列表失败'
    });
  }
};

const createThread = async (req, res) => {
  try {
    const crypto = require('crypto');
    const threadId = crypto.randomUUID();
    const userId = req.body.user_id || 'anonymous';

    await Thread.create({
      thread_id: threadId,
      user_id: userId,
      status: 'idle',
      messages: []
    });

    res.json({
      success: true,
      message: '创建会话成功',
      data: {
        thread_id: threadId,
        created_at: new Date().toISOString(),
        status: 'idle'
      }
    });
  } catch (error) {
    console.error('创建thread失败:', error.message);
    res.status(500).json({
      success: false,
      message: '创建会话失败'
    });
  }
};

const listThreads = async (req, res) => {
  try {
    const userId = req.query.user_id || 'anonymous';

    const threads = await Thread.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      attributes: ['thread_id', 'user_id', 'status', 'messages', 'created_at', 'updated_at']
    });

    res.json({
      success: true,
      message: '获取会话列表成功',
      data: threads.map(thread => {
        const json = thread.toJSON();
        const allMessages = json.messages || [];
        const filteredMessages = allMessages.filter(msg => msg.type !== 'system');
        const firstUserMessage = filteredMessages.find(msg => msg.type === 'human');
        const title = firstUserMessage?.content?.slice(0, 30) || '新会话';

        return {
          thread_id: json.thread_id,
          user_id: json.user_id,
          status: json.status,
          messages: filteredMessages.map(msg => ({
            type: msg.type,
            content: msg.content,
            timestamp: msg.timestamp || json.updated_at
          })),
          title: title,
          message_count: filteredMessages.length,
          created_at: json.created_at,
          updated_at: json.updated_at
        };
      })
    });
  } catch (error) {
    console.error('获取会话列表失败:', error.message);
    res.status(500).json({
      success: false,
      message: '获取会话列表失败'
    });
  }
};

const getThreadState = async (req, res) => {
  try {
    const { threadId } = req.params;
    const thread = await Thread.findOne({ where: { thread_id: threadId } });

    if (!thread) {
      return res.status(404).json({
        success: false,
        message: '会话不存在'
      });
    }

    res.json({
      success: true,
      message: '获取会话状态成功',
      data: {
        thread_id: threadId,
        values: {
          messages: (thread.messages || []).filter(msg => msg.type !== 'system')
        },
        next: [],
        created_at: thread.created_at,
        status: thread.status
      }
    });
  } catch (error) {
    console.error('获取thread状态失败:', error.message);
    res.status(500).json({
      success: false,
      message: '获取会话状态失败'
    });
  }
};

const deleteThread = async (req, res) => {
  try {
    const { threadId } = req.params;

    const thread = await Thread.findOne({ where: { thread_id: threadId } });
    if (!thread) {
      return res.status(404).json({
        success: false,
        message: '会话不存在'
      });
    }

    await Run.destroy({ where: { thread_id: threadId } });
    await thread.destroy();

    res.json({
      success: true,
      message: '会话已删除'
    });
  } catch (error) {
    console.error('删除thread失败:', error.message);
    res.status(500).json({
      success: false,
      message: '删除会话失败'
    });
  }
};

const cancelRun = async (req, res) => {
  try {
    const { runId } = req.params;
    const run = await Run.findOne({ where: { run_id: runId } });

    if (!run) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }

    await run.update({ status: 'cancelled' });
    res.json({
      success: true,
      message: '执行已取消',
      data: { run_id: runId, status: 'cancelled' }
    });
  } catch (error) {
    console.error('取消run失败:', error.message);
    res.status(500).json({ success: false, message: '取消执行失败' });
  }
};

const processChain = async (req, res) => {
  try {
    const { input, model } = req.body;

    if (!input) {
      return res.status(400).json({
        success: false,
        message: '缺少input参数'
      });
    }

    const result = await langchainService.processDataChain(input, { model });

    res.json({
      success: true,
      message: '处理成功',
      data: result
    });
  } catch (error) {
    console.error('数据处理链失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '数据处理链失败'
    });
  }
};

// ========== uploadController ==========

const uploadSingle = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    const filePath = req.file.path;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const knowledgeMetadata = normalizeKnowledgeMetadata(req.body || {});

    console.log(`文件已保存到本地: ${filePath}`);
    console.log(`开始上传到阿里云知识库: ${originalName}`);

    const { fileId, status } = await ragService.uploadFileToKnowledgeBase(filePath, originalName, knowledgeMetadata);
    console.log(`文件解析完成，fileId: ${fileId}, status: ${status}`);

    const jobId = await ragService.addFileToIndex(fileId);
    console.log(`索引任务已提交，jobId: ${jobId}`);

    try {
      await documentSourceService.archiveUploadedFile(req.file, originalName, {
        documentId: fileId,
        fileId,
        jobId,
        sourceMode: 'aliyun',
        ...knowledgeMetadata
      });
    } catch (archiveError) {
      console.warn('知识库源文件留存失败:', archiveError.message);
    }

    fs.unlinkSync(filePath);
    console.log(`临时文件已删除: ${filePath}`);

    res.json({
      success: true,
      message: '文档上传并加入知识库成功',
      data: {
        fileName: originalName,
        fileId,
        jobId,
        status,
        knowledgeScope: knowledgeMetadata.knowledgeScope,
        knowledgeChannels: knowledgeMetadata.knowledgeChannels
      }
    });
  } catch (error) {
    console.error('阿里云知识库上传失败:', error.message);

    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        console.error('删除临时文件失败:', e.message);
      }
    }

    res.status(500).json({
      success: false,
      message: error.message || '文档上传失败'
    });
  }
};

const uploadBatch = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    console.log(`批量上传：${req.files.length} 个文件`);

    const results = [];

    for (const file of req.files) {
      try {
        const filePath = file.path;
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const knowledgeMetadata = normalizeKnowledgeMetadata(req.body || {});

        console.log(`处理文件: ${originalName}`);

        const { fileId, status } = await ragService.uploadFileToKnowledgeBase(filePath, originalName, knowledgeMetadata);
        const jobId = await ragService.addFileToIndex(fileId);

        try {
          await documentSourceService.archiveUploadedFile(file, originalName, {
            documentId: fileId,
            fileId,
            jobId,
            sourceMode: 'aliyun',
            ...knowledgeMetadata
          });
        } catch (archiveError) {
          console.warn('知识库源文件留存失败:', archiveError.message);
        }

        results.push({
          fileName: originalName,
          fileId,
          jobId,
          status: 'success',
          knowledgeScope: knowledgeMetadata.knowledgeScope,
          knowledgeChannels: knowledgeMetadata.knowledgeChannels
        });

        fs.unlinkSync(filePath);
      } catch (error) {
        results.push({
          fileName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
          status: 'failed',
          error: error.message
        });

        try {
          fs.unlinkSync(file.path);
        } catch (e) {}
      }
    }

    res.json({
      success: true,
      message: `批量上传完成，成功 ${results.filter(r => r.status === 'success').length} 个，失败 ${results.filter(r => r.status === 'failed').length} 个`,
      data: results
    });
  } catch (error) {
    console.error('批量上传失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '批量上传失败'
    });
  }
};

// ========== localController ==========

const uploadToBailian = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    const filePath = req.file.path;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const knowledgeMetadata = normalizeKnowledgeMetadata(req.body || {});

    const templateId = req.body.templateId || 'default';
    let templateConfig = null;
    if (req.body.templateConfig) {
      try {
        templateConfig = JSON.parse(req.body.templateConfig);
      } catch (e) {
        console.warn('模板配置解析失败，使用默认配置');
      }
    }

    const waitForIndex = req.body.waitForIndex === 'true';

    console.log('========== 本地解析 + 百炼上传流程开始 ==========');
    console.log('文件:', originalName);
    console.log('模板:', templateId);
    console.log('等待索引:', waitForIndex);

    const result = await localParserService.processAndUploadToIndex(filePath, originalName, {
      templateId,
      template: templateConfig,
      waitForIndex,
      knowledgeMetadata
    });

    try {
      await documentSourceService.archiveUploadedFile(req.file, originalName, {
        jobId: result.jobId,
        sourceMode: 'local',
        ...knowledgeMetadata
      });
    } catch (archiveError) {
      console.warn('知识库源文件留存失败:', archiveError.message);
    }

    fs.unlinkSync(filePath);
    console.log('临时文件已删除');

    res.json({
      success: true,
      message: '文档处理并上传到百炼成功',
      data: {
        fileName: result.fileName,
        chunkCount: result.chunkCount,
        jobId: result.jobId,
        templateId: templateId,
        structuredNodes: result.structuredNodes,
        knowledgeScope: knowledgeMetadata.knowledgeScope,
        knowledgeChannels: knowledgeMetadata.knowledgeChannels
      }
    });
  } catch (error) {
    console.error('本地解析+百炼上传失败:', error.message);

    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      message: error.message || '处理失败'
    });
  }
};

const uploadToBailianBatch = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    const templateId = req.body.templateId || 'default';
    const knowledgeMetadata = normalizeKnowledgeMetadata(req.body || {});
    let templateConfig = null;
    if (req.body.templateConfig) {
      try {
        templateConfig = JSON.parse(req.body.templateConfig);
      } catch (e) {}
    }

    console.log(`批量处理：${req.files.length} 个文件`);
    console.log(`模板: ${templateId}`);

    const results = [];

    for (const file of req.files) {
      try {
        const filePath = file.path;
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

        const result = await localParserService.processAndUploadToIndex(filePath, originalName, {
          templateId,
          template: templateConfig,
          waitForIndex: false,
          knowledgeMetadata
        });

        try {
          await documentSourceService.archiveUploadedFile(file, originalName, {
            jobId: result.jobId,
            sourceMode: 'local',
            ...knowledgeMetadata
          });
        } catch (archiveError) {
          console.warn('知识库源文件留存失败:', archiveError.message);
        }

        results.push({
          fileName: result.fileName,
          status: 'success',
          chunkCount: result.chunkCount,
          jobId: result.jobId,
          knowledgeScope: knowledgeMetadata.knowledgeScope,
          knowledgeChannels: knowledgeMetadata.knowledgeChannels
        });

        fs.unlinkSync(filePath);
      } catch (error) {
        results.push({
          fileName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
          status: 'failed',
          error: error.message
        });

        try { fs.unlinkSync(file.path); } catch (e) {}
      }
    }

    res.json({
      success: true,
      message: `批量处理完成，成功 ${results.filter(r => r.status === 'success').length} 个`,
      data: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || '批量处理失败'
    });
  }
};

const previewChunks = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    const filePath = req.file.path;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const knowledgeMetadata = normalizeKnowledgeMetadata(req.body || {});

    const templateId = req.body.templateId || 'default';
    let templateConfig = null;
    if (req.body.templateConfig) {
      try {
        templateConfig = JSON.parse(req.body.templateConfig);
      } catch (e) {
        console.warn('模板配置解析失败，使用默认配置');
      }
    }

    console.log('========== 预览分块流程开始 ==========');
    console.log('文件:', originalName);
    console.log('模板:', templateId);

    const result = await localParserService.previewChunks(filePath, originalName, {
      template: templateConfig,
      knowledgeMetadata
    });

    let sourceArchiveId = null;
    try {
      const sourceArchive = await documentSourceService.archiveUploadedFile(req.file, originalName, {
        sourceMode: 'local',
        ...knowledgeMetadata
      });
      sourceArchiveId = sourceArchive?.id || null;
    } catch (archiveError) {
      console.warn('知识库源文件留存失败:', archiveError.message);
    }

    fs.unlinkSync(filePath);
    console.log('临时文件已删除');

    res.json({
      success: true,
      message: '分块预览成功',
      data: {
        fileName: result.fileName,
        chunks: result.chunks,
        chunkStats: result.chunkStats,
        structuredNodes: result.structuredNodes,
        structuredNodesPreview: result.structuredNodesPreview,
        templateId: templateId,
        sourceArchiveId,
        knowledgeScope: knowledgeMetadata.knowledgeScope,
        knowledgeChannels: knowledgeMetadata.knowledgeChannels
      }
    });
  } catch (error) {
    console.error('预览分块失败:', error.message);

    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      message: error.message || '预览失败'
    });
  }
};

const confirmUpload = async (req, res) => {
  try {
    const { chunks, fileName, waitForIndex, sourceArchiveId } = req.body;
    const knowledgeMetadata = normalizeKnowledgeMetadata(req.body || {});

    if (!chunks || chunks.length === 0) {
      return res.status(400).json({
        success: false,
        message: '分块数据为空，无法上传'
      });
    }

    if (!fileName) {
      return res.status(400).json({
        success: false,
        message: '缺少fileName参数'
      });
    }

    console.log('========== 确认上传流程开始 ==========');
    console.log('文件:', fileName);
    console.log('分块数量:', chunks.length);
    console.log('等待索引:', waitForIndex);

    const result = await localParserService.confirmUploadChunks(chunks, fileName, {
      waitForIndex: waitForIndex === true || waitForIndex === 'true'
    });

    if (sourceArchiveId) {
      try {
        await documentSourceService.updateSourceMapping(sourceArchiveId, {
          jobId: result.jobId,
          ...knowledgeMetadata
        });
      } catch (archiveError) {
        console.warn('知识库源文件映射更新失败:', archiveError.message);
      }
    }

    res.json({
      success: true,
      message: '确认上传成功',
      data: {
        jobId: result.jobId,
        uploadedCount: result.uploadedCount,
        fileName: result.fileName,
        knowledgeScope: knowledgeMetadata.knowledgeScope,
        knowledgeChannels: knowledgeMetadata.knowledgeChannels
      }
    });
  } catch (error) {
    console.error('确认上传失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '上传失败'
    });
  }
};

// ========== templateController ==========

const listTemplates = async (req, res) => {
  try {
    const { pageSize, pageNumber } = req.query;

    const templates = await templateService.listTemplates({
      pageSize: pageSize ? parseInt(pageSize) : 50,
      pageNumber: pageNumber ? parseInt(pageNumber) : 1
    });

    res.json({
      success: true,
      message: '获取模板列表成功',
      data: { templates }
    });
  } catch (error) {
    console.error('获取模板列表失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '获取模板列表失败'
    });
  }
};

const getTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const template = await templateService.getTemplate(templateId);

    res.json({
      success: true,
      message: '获取模板详情成功',
      data: template
    });
  } catch (error) {
    console.error('获取模板详情失败:', error.message);
    res.status(404).json({
      success: false,
      message: error.message || '模板不存在'
    });
  }
};

const getDefaultTemplate = async (req, res) => {
  try {
    const config = await templateService.getDefaultTemplate();

    res.json({
      success: true,
      message: '获取默认模板成功',
      data: {
        templateId: 'default',
        config
      }
    });
  } catch (error) {
    console.error('获取默认模板失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '获取默认模板失败'
    });
  }
};

const createTemplate = async (req, res) => {
  try {
    const { name, templateId, config, description } = req.body;

    if (!name || !templateId) {
      return res.status(400).json({
        success: false,
        message: '模板名称和模板ID为必填项'
      });
    }

    const result = await templateService.createTemplate({
      name,
      templateId,
      config,
      description
    });

    res.json({
      success: true,
      message: '模板创建成功',
      data: result
    });
  } catch (error) {
    console.error('创建模板失败:', error.message);
    res.status(400).json({
      success: false,
      message: error.message || '创建模板失败'
    });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    const { name, config, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: '模板名称为必填项'
      });
    }

    const result = await templateService.updateTemplate(templateId, {
      name,
      config,
      description
    });

    res.json({
      success: true,
      message: '模板更新成功',
      data: result
    });
  } catch (error) {
    console.error('更新模板失败:', error.message);
    res.status(400).json({
      success: false,
      message: error.message || '更新模板失败'
    });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const result = await templateService.deleteTemplate(templateId);

    res.json({
      success: true,
      message: '模板删除成功',
      data: result
    });
  } catch (error) {
    console.error('删除模板失败:', error.message);
    res.status(400).json({
      success: false,
      message: error.message || '删除模板失败'
    });
  }
};

const setDefaultTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;

    const result = await templateService.setDefaultTemplate(templateId);

    res.json({
      success: true,
      message: '默认模板设置成功',
      data: result
    });
  } catch (error) {
    console.error('设置默认模板失败:', error.message);
    res.status(400).json({
      success: false,
      message: error.message || '设置默认模板失败'
    });
  }
};

const initTemplatesTable = async (req, res) => {
  try {
    await templateService.createTemplatesTable();

    res.json({
      success: true,
      message: '模板表初始化成功'
    });
  } catch (error) {
    console.error('初始化模板表失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '初始化模板表失败'
    });
  }
};

// ========== chatAttachmentController ==========

const uploadAttachment = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    const filePath = req.file.path;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const fileType = path.extname(originalName).toLowerCase();

    console.log('========== 聊天附件解析开始 ==========');
    console.log('文件:', originalName);
    console.log('类型:', fileType);
    console.log('路径:', filePath);

    const structuredNodes = await localParserService.parseDocument(filePath, fileType);

    let textContent = '';
    const chunks = [];

    for (const node of structuredNodes) {
      if (node.content) {
        textContent += node.content + '\n\n';

        chunks.push({
          type: node.type,
          level: node.level,
          content: node.content,
          path: node.path || []
        });
      }
    }

    try {
      fs.unlinkSync(filePath);
      console.log('临时文件已删除:', filePath);
    } catch (e) {
      console.warn('删除临时文件失败:', e.message);
    }

    console.log(`解析完成，提取 ${structuredNodes.length} 个节点，文本长度 ${textContent.length}`);

    res.json({
      success: true,
      message: '附件解析成功',
      data: {
        fileName: originalName,
        fileType: fileType,
        textContent: textContent,
        chunks: chunks,
        structuredNodes: structuredNodes.slice(0, 20),
        stats: {
          totalNodes: structuredNodes.length,
          totalLength: textContent.length,
          chunkCount: chunks.length
        }
      }
    });
  } catch (error) {
    console.error('附件解析失败:', error.message);
    console.error(error.stack);

    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      message: error.message || '附件解析失败'
    });
  }
};

const uploadBatchAttachments = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请选择要上传的文件'
      });
    }

    console.log(`批量附件解析：${req.files.length} 个文件`);

    const results = [];

    for (const file of req.files) {
      try {
        const filePath = file.path;
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const fileType = path.extname(originalName).toLowerCase();

        const structuredNodes = await localParserService.parseDocument(filePath, fileType);

        let textContent = '';
        for (const node of structuredNodes) {
          if (node.content) {
            textContent += node.content + '\n\n';
          }
        }

        results.push({
          fileName: originalName,
          status: 'success',
          textContent: textContent,
          totalNodes: structuredNodes.length
        });

        try { fs.unlinkSync(filePath); } catch (e) {}
      } catch (error) {
        results.push({
          fileName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
          status: 'failed',
          error: error.message
        });

        try { fs.unlinkSync(file.path); } catch (e) {}
      }
    }

    res.json({
      success: true,
      message: `批量解析完成，成功 ${results.filter(r => r.status === 'success').length} 个`,
      data: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || '批量解析失败'
    });
  }
};

// ========== adminController ==========

const getStats = async (req, res) => {
  try {
    const stats = {
      documents: await Document.count()
    };

    res.json({
      success: true,
      message: '获取统计数据成功',
      data: stats
    });
  } catch (error) {
    console.error('获取统计数据失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || '获取统计数据失败'
    });
  }
};

// ========== 用户/坐席管理 ==========

const normalizeSkillNames = (skills = []) => {
  if (!Array.isArray(skills)) return [];
  return [...new Set(
    skills
      .map(skill => String(skill || '').trim())
      .filter(Boolean)
      .map(skill => skill.slice(0, 50))
  )];
};

const ensureSeatSkillTags = async (skills = []) => {
  const names = normalizeSkillNames(skills);
  if (names.length === 0) return names;

  await Promise.all(names.map(name => SeatSkillTag.findOrCreate({
    where: { name },
    defaults: { name, sortOrder: 100 }
  })));

  return names;
};

const getSeatSkillTags = async (req, res) => {
  try {
    const tags = await SeatSkillTag.findAll({
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
      attributes: ['id', 'name', 'sortOrder', 'createdAt']
    });

    res.json({
      success: true,
      message: '获取技能标签成功',
      data: tags
    });
  } catch (error) {
    console.error('获取技能标签失败:', error.message);
    res.status(500).json({ success: false, message: error.message || '获取技能标签失败' });
  }
};

const createSeatSkillTag = async (req, res) => {
  try {
    const [name] = normalizeSkillNames([req.body.name]);
    if (!name) {
      return res.status(400).json({ success: false, message: '技能标签不能为空' });
    }

    const [tag, created] = await SeatSkillTag.findOrCreate({
      where: { name },
      defaults: { name, sortOrder: 100 }
    });

    res.status(created ? 201 : 200).json({
      success: true,
      message: created ? '技能标签已添加' : '技能标签已存在',
      data: tag
    });
  } catch (error) {
    console.error('添加技能标签失败:', error.message);
    res.status(500).json({ success: false, message: error.message || '添加技能标签失败' });
  }
};

const deleteSeatSkillTag = async (req, res) => {
  try {
    const { id } = req.params;
    const tag = await SeatSkillTag.findByPk(id);
    if (!tag) {
      return res.status(404).json({ success: false, message: '技能标签不存在' });
    }

    const tagName = tag.name;
    const users = await User.findAll({
      attributes: ['id', 'skills']
    });

    await Promise.all(users.map(user => {
      const nextSkills = normalizeSkillNames(user.skills).filter(skill => skill !== tagName);
      if (JSON.stringify(nextSkills) === JSON.stringify(normalizeSkillNames(user.skills))) return null;
      return user.update({ skills: nextSkills });
    }).filter(Boolean));

    await tag.destroy();

    res.json({
      success: true,
      message: '技能标签已删除',
      data: { id: Number(id), name: tagName }
    });
  } catch (error) {
    console.error('删除技能标签失败:', error.message);
    res.status(500).json({ success: false, message: error.message || '删除技能标签失败' });
  }
};

// 获取用户列表（支持 role 筛选，含坐席绑定的账号信息）
const getUsers = async (req, res) => {
  try {
    const { role } = req.query;
    const where = {};
    if (role) where.role = role;

    const users = await User.findAll({
      where,
      attributes: ['id', 'username', 'email', 'role', 'status', 'skills', 'maxConcurrent', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });

    // 为坐席角色查询绑定的账号
    const seatIds = users.filter(u => ['agent', 'supervisor'].includes(u.role)).map(u => u.id);
    let bindingsBySeat = {};

    if (seatIds.length > 0) {
      const bindings = await SeatAccountBinding.findAll({
        where: { seat_id: seatIds, status: 'active' },
        order: [['created_at', 'DESC']]
      });

      // 批量查询关联的渠道账号
      const accountIds = bindings.map(b => b.account_id);
      const accounts = accountIds.length > 0
        ? await ChannelAccount.findAll({
          where: { id: accountIds },
          attributes: ['id', 'channel', 'account_name', 'status', 'phone_number', 'whatsapp_name']
        })
        : [];
      const accountMap = {};
      accounts.forEach(a => { accountMap[a.id] = a.toJSON() });

      // 按坐席分组
      const CHANNEL_META = {
        whatsapp: { label: 'WhatsApp', color: '#25D366' },
        douyin: { label: '抖音', color: '#FE2C55' },
        wechat: { label: '微信', color: '#07C160' }
      };

      bindings.forEach(b => {
        const bJson = b.toJSON();
        const accountInfo = accountMap[bJson.account_id] || {};
        if (!bindingsBySeat[bJson.seat_id]) bindingsBySeat[bJson.seat_id] = [];
        bindingsBySeat[bJson.seat_id].push({
          binding_id: bJson.id,
          account_id: bJson.account_id,
          channel: bJson.channel,
          account_name: accountInfo.account_name || '',
          phone_number: accountInfo.phone_number || '',
          whatsapp_name: accountInfo.whatsapp_name || '',
          account_status: accountInfo.status || '',
          channel_meta: CHANNEL_META[bJson.channel] || { label: bJson.channel, color: '#909399' }
        });
      });
    }

    // 将绑定信息附加到每个坐席用户
    const result = users.map(user => {
      const u = user.toJSON();
      u.bound_accounts = bindingsBySeat[u.id] || [];
      return u;
    });

    res.json({
      success: true,
      message: '获取用户列表成功',
      data: result
    });
  } catch (error) {
    console.error('获取用户列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message || '获取用户列表失败' });
  }
};

// 更新用户（role/status/skills/maxConcurrent）
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, status, skills, maxConcurrent } = req.body;

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    const updates = {};
    if (role !== undefined) updates.role = role;
    if (status !== undefined) updates.status = status;
    if (skills !== undefined) updates.skills = await ensureSeatSkillTags(skills);
    if (maxConcurrent !== undefined) {
      const parsedMaxConcurrent = Number(maxConcurrent);
      if (!Number.isInteger(parsedMaxConcurrent) || parsedMaxConcurrent < 1) {
        return res.status(400).json({ success: false, message: '最大接待数必须是大于 0 的整数' });
      }
      updates.maxConcurrent = parsedMaxConcurrent;
    }

    await user.update(updates);
    if (maxConcurrent !== undefined) {
      const poolService = require('../conversation-pool/pool.service');
      await poolService.syncSeatMaxConcurrent(user.id, user.maxConcurrent);
    }

    res.json({
      success: true,
      message: '更新成功',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        skills: user.skills,
        maxConcurrent: user.maxConcurrent
      }
    });
  } catch (error) {
    console.error('更新用户失败:', error.message);
    res.status(500).json({ success: false, message: error.message || '更新用户失败' });
  }
};

// 删除用户
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    await user.destroy();
    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('删除用户失败:', error.message);
    res.status(500).json({ success: false, message: error.message || '删除用户失败' });
  }
};

module.exports = {
  // chat
  sendMessage,
  // knowledge
  listDocuments,
  deleteDocuments,
  describeDocument,
  listDocumentChunks,
  downloadDocument,
  // langchain
  getModels,
  getAssistants,
  createThread,
  listThreads,
  getThreadState,
  deleteThread,
  cancelRun,
  processChain,
  // upload
  uploadSingle,
  uploadBatch,
  // local
  uploadToBailian,
  uploadToBailianBatch,
  previewChunks,
  confirmUpload,
  // template
  listTemplates,
  getTemplate,
  getDefaultTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate,
  initTemplatesTable,
  // chatAttachment
  uploadAttachment,
  uploadBatchAttachments,
  // admin
  getStats,
  getSeatSkillTags,
  createSeatSkillTag,
  deleteSeatSkillTag,
  getUsers,
  updateUser,
  deleteUser
};
