require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Bailian20231229 = require('@alicloud/bailian20231229');
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');
const OpenAI = require('openai');
const documentSourceService = require('./documentSourceService');
const { putFileToLeaseUrl } = require('./bailianUploadTransport');
const {
  buildAllowedKnowledgeFilter,
  isKnowledgeNodeAllowed,
  normalizeKnowledgeMetadata,
  parseKnowledgeMetadataFromText
} = require('./knowledgeScope');

// ========== 配置项 ==========
const WORKSPACE_ID = process.env.WORKSPACE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const INDEX_ID = process.env.INDEX_ID;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus';

// ========== 初始化 OpenAI 客户端（延迟初始化，避免模块加载时环境变量未就绪） ==========
let openai = null;
function getOpenAI() {
  if (!openai) {
    const apiKey = process.env.DASHSCOPE_API_KEY || DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY 未配置，请检查 .env 文件');
    }
    openai = new OpenAI({
      apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    });
  }
  return openai;
}

/**
 * 初始化百炼客户端
 */
function createClient() {
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    endpoint: 'bailian.cn-beijing.aliyuncs.com',
    regionId: 'cn-beijing'
  });
  return new Bailian20231229.default(config);
}

/**
 * 计算文件MD5和大小
 */
function getFileInfo(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const size = fs.statSync(filePath).size;
  const fileName = filePath.split('/').pop() || filePath.split('\\').pop();
  return { fileName, md5, size };
}

/**
 * 主流程：上传文件到百炼知识库
 * @param {string} filePath - 本地文件路径
 * @param {string} originalFileName - 原始文件名（可选，如果不提供则从filePath提取）
 */
async function uploadFileToKnowledgeBase(filePath, originalFileName, knowledgeMetadata = null) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});
  const scopedUpload = prepareScopedUploadFile(filePath, originalFileName, knowledgeMetadata);
  const uploadPath = scopedUpload.filePath;
  const { md5: fileMd5, size: fileSize } = getFileInfo(uploadPath);
  
  // 使用传入的原始文件名，或从路径提取
  const fileName = originalFileName || getFileInfo(filePath).fileName;

  try {
  console.log('1. 准备文件信息：', { fileName, fileSize, originalFileName });

  // ========== 步骤1：申请文件上传租约 ==========
  console.log('2. 申请上传租约...');
  const applyLeaseRequest = new Bailian20231229.ApplyFileUploadLeaseRequest({
    fileName,
    md5: fileMd5,
    sizeInBytes: fileSize.toString()
  });

  console.log('请求参数:', {
    CategoryId: CATEGORY_ID,
    WorkspaceId: WORKSPACE_ID,
    FileName: fileName,
    Md5: fileMd5,
    SizeInBytes: fileSize.toString()
  });

  const headers = {};
  const leaseResponse = await client.applyFileUploadLeaseWithOptions(
    CATEGORY_ID,
    WORKSPACE_ID,
    applyLeaseRequest,
    headers,
    runtime
  );

  console.log('租约响应:', JSON.stringify(leaseResponse.body, null, 2));

  const leaseData = leaseResponse.body.data;
  const leaseId = leaseData.fileUploadLeaseId;
  const uploadUrl = leaseData.param.url;
  const uploadHeaders = leaseData.param.headers;

  console.log('租约申请成功，leaseId:', leaseId);

  // ========== 步骤2：直传文件到OSS预签名地址 ==========
  console.log('3. 上传文件到存储...');
  await putFileToLeaseUrl(uploadUrl, uploadPath, uploadHeaders);
  console.log('文件上传完成');

  // ========== 步骤3：确认上传，触发后台解析 ==========
  console.log('4. 提交文件，启动解析...');
  const addFileRequest = new Bailian20231229.AddFileRequest({
    leaseId,
    categoryId: CATEGORY_ID,
    parser: 'DASHSCOPE_DOCMIND'
  });

  const addFileResponse = await client.addFileWithOptions(
    WORKSPACE_ID,
    addFileRequest,
    {},
    runtime
  );

  const fileId = addFileResponse.body.data.fileId;
  console.log('文件已提交，fileId:', fileId);

  // ========== 步骤4：轮询解析状态 ==========
  console.log('5. 轮询解析状态...');
  let status = 'INIT';
  const maxRetry = 60; // 最多轮询5分钟
  let retry = 0;

  while (retry < maxRetry) {
    const describeRequest = new Bailian20231229.DescribeFileRequest({});
    const describeResponse = await client.describeFileWithOptions(
      WORKSPACE_ID,
      fileId,
      describeRequest,
      {},
      runtime
    );

    status = describeResponse.body.data.status;
    console.log(`当前状态：${status} (${retry + 1}/${maxRetry})`);

    if (status === 'PARSE_SUCCESS') {
      console.log('✅ 文件解析成功！已加入数据中心');
      break;
    }
    if (status === 'PARSE_FAILED') {
      throw new Error('❌ 文件解析失败：' + describeResponse.body.data.errorMessage);
    }

    // 每5秒轮询一次
    await new Promise(resolve => setTimeout(resolve, 5000));
    retry++;
  }

  return { fileId, status };
  } finally {
    if (scopedUpload.shouldCleanup && fs.existsSync(uploadPath)) {
      fs.unlinkSync(uploadPath);
    }
  }
}

function prepareScopedUploadFile(filePath, originalFileName, knowledgeMetadata = null) {
  if (!knowledgeMetadata?.knowledgeScope && !knowledgeMetadata?.knowledgeChannels) {
    return { filePath, shouldCleanup: false };
  }

  const ext = path.extname(originalFileName || filePath).toLowerCase();
  if (!['.md', '.txt'].includes(ext)) {
    return { filePath, shouldCleanup: false };
  }

  const meta = normalizeKnowledgeMetadata(knowledgeMetadata);
  const originalContent = fs.readFileSync(filePath, 'utf8');
  const prefix = `【适用范围】${meta.knowledgeScope}\n【适用渠道】${meta.knowledgeChannels.join(',')}\n\n`;
  const scopedPath = path.join(path.dirname(filePath), `${crypto.randomUUID()}-${path.basename(originalFileName || filePath)}`);
  fs.writeFileSync(scopedPath, prefix + originalContent, 'utf8');
  return { filePath: scopedPath, shouldCleanup: true };
}

/**
 * 将已解析的文件提交到知识库索引
 * @param {string} fileId - 文件ID
 */
async function addFileToIndex(fileId) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});

  const request = new Bailian20231229.SubmitIndexAddDocumentsJobRequest({
    indexId: INDEX_ID,
    sourceType: 'DATA_CENTER_FILE',
    documentIds: [fileId]
  });

  const response = await client.submitIndexAddDocumentsJobWithOptions(
    WORKSPACE_ID,
    request,
    {},
    runtime
  );

  console.log('索引任务响应:', JSON.stringify(response.body, null, 2));

  // 检查响应状态
  if (!response.body.success) {
    throw new Error(`索引任务提交失败: ${response.body.message || '未知错误'}`);
  }

  const jobId = response.body.data?.id;
  if (jobId) {
    console.log('索引任务已提交成功，jobId:', jobId);
  }
  return jobId;
}

/**
 * 查询知识库索引文档列表
 * @param {Object} options - 查询选项
 * @param {number} options.pageSize - 每页数量，默认10
 * @param {number} options.pageNumber - 页码，默认1
 * @param {string} options.documentName - 文件名过滤
 * @param {string} options.documentStatus - 文件状态过滤（INSERT_ERROR/RUNNING/DELETED/FINISH）
 * @param {string} options.indexId - 知识库ID，默认使用配置的INDEX_ID
 */
async function listDocuments(options = {}) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});

  const {
    pageSize = 10,
    pageNumber = 1,
    documentName,
    documentStatus,
    indexId = INDEX_ID
  } = options;

  const request = new Bailian20231229.ListIndexDocumentsRequest({
    indexId,
    pageSize,
    pageNumber,
    documentName,
    documentStatus
  });

  try {
    const response = await client.listIndexDocumentsWithOptions(
      WORKSPACE_ID,
      request,
      {},
      runtime
    );

    // console.log('索引文档列表响应:', JSON.stringify(response.body, null, 2));

    // 检查响应状态
    if (!response.body.success) {
      throw new Error(`查询索引文档列表失败: ${response.body.message || '未知错误'}`);
    }

    const data = response.body.data || {};
    const documents = data.documents || [];

    return {
      documents: documents.map(doc => ({
        documentId: doc.id,
        fileName: doc.name,
        fileType: doc.documentType,
        status: doc.status,
        sourceId: doc.sourceId,
        size: doc.size,
        gmtModified: doc.gmtModified,
        code: doc.code,
        message: doc.message
      })),
      totalCount: data.totalCount || documents.length,
      pageNumber: data.pageNumber,
      pageSize: data.pageSize,
      indexId: data.indexId
    };
  } catch (error) {
    console.log(error.message);
    console.log(error.data?.Recommend);
    throw error;
  }
}

/**
 * 删除知识库下的文件
 * @param {string|Array} documentIds - 文件ID或文件ID数组
 * @param {string} indexId - 知识库ID，默认使用配置的INDEX_ID
 */
async function deleteIndexDocument(documentIds, indexId = INDEX_ID) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});

  // 支持单个ID或数组
  const ids = Array.isArray(documentIds) ? documentIds : [documentIds];

  const request = new Bailian20231229.DeleteIndexDocumentRequest({
    indexId,
    documentIds: ids
  });

  try {
    const response = await client.deleteIndexDocumentWithOptions(
      WORKSPACE_ID,
      request,
      {},
      runtime
    );

    console.log('删除文档响应:', JSON.stringify(response.body, null, 2));

    // 检查响应状态
    if (!response.body.success) {
      throw new Error(`删除文档失败: ${response.body.message || '未知错误'}`);
    }

    const data = response.body.data || {};
    return {
      deletedDocuments: data.deletedDocument || [],
      requestId: response.body.requestId
    };
  } catch (error) {
    console.log(error.message);
    console.log(error.data?.Recommend);
    throw error;
  }
}

/**
 * 检索知识库
 * @param {Object} options - 检索选项
 * @param {string} options.query - 查询文本
 * @param {string} options.indexId - 知识库ID，默认使用配置的INDEX_ID
 * @param {number} options.denseSimilarityTopK - 向量检索TopK，默认10
 * @param {number} options.sparseSimilarityTopK - 关键词检索TopK，默认10
 * @param {boolean} options.enableReranking - 是否开启重排序，默认true
 * @param {number} options.rerankTopN - 重排序后返回数量，默认5
 * @param {number} options.rerankMinScore - 相似度阈值，默认0.2
 */
async function retrieve(options) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});

  const {
    query,
    indexId = INDEX_ID,
    denseSimilarityTopK = 10,
    sparseSimilarityTopK = 10,
    enableReranking = true,
    rerankTopN = 5,
    rerankMinScore = 0.2,
    channel,
    knowledgeScope,
    knowledgeChannels,
    searchFilters
  } = options;

  if (!query) {
    throw new Error('缺少query参数');
  }

  const hasKnowledgeFilter = channel || knowledgeScope || knowledgeChannels;
  const knowledgeFilter = hasKnowledgeFilter
    ? buildAllowedKnowledgeFilter(channel, { knowledgeScope, knowledgeChannels })
    : null;
  const requestDenseTopK = knowledgeFilter ? Math.min(Math.max(denseSimilarityTopK * 4, 20), 100) : denseSimilarityTopK;
  const requestSparseTopK = knowledgeFilter ? Math.min(Math.max(sparseSimilarityTopK * 4, 20), 100) : sparseSimilarityTopK;
  const requestRerankTopN = knowledgeFilter ? Math.min(Math.max(rerankTopN * 4, 20), 20) : rerankTopN;

  const request = new Bailian20231229.RetrieveRequest({
    query,
    indexId,
    denseSimilarityTopK: requestDenseTopK,
    sparseSimilarityTopK: requestSparseTopK,
    enableReranking,
    rerankTopN: requestRerankTopN,
    rerankMinScore,
    searchFilters
  });

  try {
    const response = await client.retrieveWithOptions(
      WORKSPACE_ID,
      request,
      {},
      runtime
    );

    // 检查响应状态
    if (!response.body.success) {
      throw new Error(`检索失败: ${response.body.message || '未知错误'}`);
    }

    const data = response.body.data || {};
    const nodes = data.nodes || [];
    console.log('[RagService] 检索完成，原始切片数:', nodes.length, 'requestId:', response.body.requestId || '-');
    const mappedNodes = await Promise.all(nodes.map(node => mapRetrieveNode(node)));
    const filteredNodes = knowledgeFilter
      ? mappedNodes.filter(node => isKnowledgeNodeAllowed(node, knowledgeFilter)).slice(0, rerankTopN)
      : mappedNodes;

    return {
      nodes: filteredNodes,
      requestId: response.body.requestId
    };
  } catch (error) {
    console.log(error.message);
    console.log(error.data?.Recommend);
    throw error;
  }
}

/**
 * RAG问答：检索知识库 + 大模型生成回答
 * @param {Object} options - 问答选项
 * @param {string} options.query - 用户问题
 * @param {string} options.indexId - 知识库ID，默认使用配置的INDEX_ID
 * @param {string} options.model - 大模型名称，默认qwen-plus
 * @param {number} options.topK - 检索返回数量，默认5
 * @param {boolean} options.stream - 是否流式输出，默认false
 */
async function ragChat(options) {
  const {
    query,
    indexId = INDEX_ID,
    model = DASHSCOPE_MODEL,
    topK = 3,
    stream = false
  } = options;

  if (!query) {
    throw new Error('缺少query参数');
  }

  // 1. 检索知识库获取相关文档
  console.log('1. 检索知识库...');
  const retrieveResult = await retrieve({
    query,
    indexId,
    denseSimilarityTopK: topK,
    sparseSimilarityTopK: topK,
    enableReranking: true,
    rerankTopN: topK
  });

  const nodes = retrieveResult.nodes || [];
  console.log(`检索到 ${nodes.length} 个相关文档切片`);

  // 2. 构建上下文
  let context = '';
  if (nodes.length > 0) {
    context = '以下是从知识库检索到的相关信息：\n\n';
    nodes.forEach((node, index) => {
      context += `[文档${index + 1}] 来源：${node.docName || '未知'}\n`;
      context += `${node.text}\n\n`;
    });
  }

  // 3. 构建消息
  const systemPrompt = context
    ? `你是一个智能助手，请基于以下知识库信息回答用户问题。如果知识库中没有相关信息，请根据你的知识如实回答，但要说明这部分不是来自知识库。

${context}`
    : '你是一个智能助手，请根据你的知识如实回答用户问题，如果搜索不到相关信息如实回答不要编造信息。';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: query }
  ];

  // 4. 调用大模型生成回答
  console.log('2. 调用大模型生成回答...');
  console.log('请求参数:', JSON.stringify({
    model,
    messageCount: messages.length,
    stream,
    contextLength: context.length,
    sourceCount: nodes.length
  }, null, 2));

  try {
    if (stream) {
      // 流式输出
      const streamResponse = await getOpenAI().chat.completions.create({
        model,
        messages,
        stream: true
      });

      return {
        stream: streamResponse,
        sources: nodes.slice(0, 3).map(n => ({
          docName: n.docName,
          score: n.score
        }))
      };
    } else {
      // 非流式输出
      const response = await getOpenAI().chat.completions.create({
        model,
        messages,
        stream: false
      });

      const answer = response.choices[0]?.message?.content || '';

      return {
        answer,
        sources: nodes.slice(0, 3).map(n => ({
          docName: n.docName,
          score: n.score
        })),
        model: response.model,
        usage: response.usage
      };
    }
  } catch (error) {
    console.error('调用大模型失败:', error.message);
    console.error('错误详情:', error);
    if (error.response) {
      console.error('响应数据:', JSON.stringify(error.response.data, null, 2));
    }
    throw new Error(`调用大模型失败: ${error.message}`);
  }
}

/**
 * 查询单个文件详情
 * @param {string} fileId - 文件ID
 */
async function describeDocument(fileId) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});

  const request = new Bailian20231229.DescribeFileRequest({});

  const response = await client.describeFileWithOptions(
    WORKSPACE_ID,
    fileId,
    request,
    {},
    runtime
  );

  if (!response.body.success) {
    throw new Error(`查询文件详情失败: ${response.body.message || '未知错误'}`);
  }

  const data = response.body.data || {};
  console.log('[RagService] 文件详情查询完成，fileId:', fileId, 'status:', data.status || '-');
  return {
    fileId: data.fileId,
    fileName: data.fileName,
    fileType: data.fileType,
    status: data.status,
    createTime: data.createTime,
    updateTime: data.updateTime,
    sizeInBytes: data.sizeInBytes,
    errorMessage: data.errorMessage
  };
}

/**
 * 获取文档切片列表（调用百炼 ListChunks API）
 * @param {string} fileId - 文件ID（documentId）
 * @param {number} pageNum - 页码，默认1
 * @param {number} pageSize - 每页数量，最大100，默认10
 */
async function listDocumentChunks(fileId, pageNum = 1, pageSize = 10) {
  const client = createClient();
  const runtime = new Util.RuntimeOptions({});

  const request = new Bailian20231229.ListChunksRequest({
    indexId: INDEX_ID,
    fileId: fileId,
    pageNum: pageNum,
    pageSize: pageSize
  });

  const response = await client.listChunksWithOptions(
    WORKSPACE_ID,
    request,
    {},
    runtime
  );

  if (!response.body.success) {
    throw new Error(`查询切片列表失败: ${response.body.message || '未知错误'}`);
  }

  const data = response.body.data || {};
  console.log('[RagService] 切片列表查询完成，fileId:', fileId, '数量:', (data.nodes || []).length, '总数:', data.total || 0);
  const nodes = (data.nodes || []).map(node => ({
    text: node.text || '',
    score: node.score || 0,
    metadata: node.metadata || {}
  }));

  return {
    total: data.total || 0,
    pageNum: pageNum,
    pageSize: pageSize,
    chunks: nodes
  };
}

// 导出模块
module.exports = {
  uploadFileToKnowledgeBase,
  addFileToIndex,
  listDocuments,
  deleteIndexDocument,
  retrieve,
  ragChat,
  describeDocument,
  listDocumentChunks,
  createClient,
  getFileInfo
}

async function mapRetrieveNode(node) {
  const textMetadata = parseKnowledgeMetadataFromText(node.text || '');
  let sourceMetadata = null;
  const docName = node.metadata?.doc_name;
  if (docName) {
    try {
      sourceMetadata = await documentSourceService.findSource({
        documentId: node.metadata?.doc_id,
        fileName: docName
      });
    } catch {
      sourceMetadata = null;
    }
  }

  const fallbackUnknownScope = process.env.KNOWLEDGE_UNKNOWN_SCOPE_DEFAULT || 'overseas';
  const knowledgeMeta = normalizeKnowledgeMetadata({
    knowledgeScope: node.metadata?.knowledgeScope || node.metadata?.scope || textMetadata.knowledgeScope || sourceMetadata?.knowledge_scope || fallbackUnknownScope,
    knowledgeChannels: node.metadata?.knowledgeChannels || node.metadata?.channels || textMetadata.knowledgeChannels || sourceMetadata?.knowledge_channels
  });

  return {
    text: node.text,
    score: node.score,
    docName,
    docId: node.metadata?.doc_id,
    title: node.metadata?.title,
    content: node.metadata?.content,
    knowledgeScope: knowledgeMeta.knowledgeScope,
    knowledgeChannels: knowledgeMeta.knowledgeChannels,
    metadata: {
      ...(node.metadata || {}),
      knowledgeScope: knowledgeMeta.knowledgeScope,
      knowledgeChannels: knowledgeMeta.knowledgeChannels
    }
  };
}
