require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sequelize } = require('../../config/database');
const { normalizeKnowledgeMetadata } = require('./knowledgeScope');
const { putFileToLeaseUrl } = require('./bailianUploadTransport');

// ========== Polyfill for mammoth (Node.js 没有 File API) ==========
// mammoth 内部使用了浏览器的 File API，需要 polyfill
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File {
    constructor(bits, name, options = {}) {
      this._bits = bits;
      this._name = name;
      this._type = options.type || '';
      this._lastModified = options.lastModified || Date.now();
    }
    get name() { return this._name; }
    get type() { return this._type; }
    get lastModified() { return this._lastModified; }
    get size() {
      return this._bits.reduce((total, bit) => {
        if (typeof bit === 'string') return total + bit.length;
        if (bit instanceof ArrayBuffer) return total + bit.byteLength;
        if (Buffer.isBuffer(bit)) return total + bit.length;
        return total;
      }, 0);
    }
    arrayBuffer() {
      const bit = this._bits[0];
      if (Buffer.isBuffer(bit)) {
        return Promise.resolve(bit.buffer.slice(bit.byteOffset, bit.byteOffset + bit.byteLength));
      }
      if (bit instanceof ArrayBuffer) return Promise.resolve(bit);
      return Promise.resolve(new ArrayBuffer(0));
    }
    text() {
      return Promise.resolve(typeof this._bits[0] === 'string' ? this._bits[0] : '');
    }
  };
}

// ========== 百炼配置（Demo 流程使用）==========
const Bailian20231229 = require('@alicloud/bailian20231229'); // 需要安装：npm install @alicloud/bailian20231229
const OpenApi = require('@alicloud/openapi-client'); // 需要安装：npm install @alicloud/openapi-client
const Util = require('@alicloud/tea-util'); // 需要安装：npm install @alicloud/tea-util

const WORKSPACE_ID = process.env.WORKSPACE_ID;
const INDEX_ID = process.env.INDEX_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;

/**
 * 创建百炼客户端（Demo 流程使用）
 */
function createBailianClient() {
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    endpoint: 'bailian.cn-beijing.aliyuncs.com',
    regionId: 'cn-beijing'
  });
  return new Bailian20231229.default(config);
}

// ========== 结构化解析配置 ==========
// 节点类型枚举
const NODE_TYPES = {
  HEADING: 'heading',
  PARAGRAPH: 'paragraph',
  TABLE: 'table',
  LIST: 'list',
  SHEET: 'sheet'
};

// ========== 分块模板配置 ==========
const defaultTemplate = {
  splitStrategy: 'heading_driven', // 分块主策略：heading_driven（标题驱动）
  maxHeadingLevel: 3, // 按几级标题拆分，默认3级
  keepTableWhole: true, // 是否整块保留表格
  keepListWhole: true, // 是否整块保留短列表
  maxChunkSize: 800, // 兜底最大字符数
  chunkOverlap: 120, // 兜底重叠字符数
  injectHeadingPath: true, // 是否自动给每个块前置拼接章节路径
  maxListLength: 10 // 短列表最大项数（超过则拆分）
};

function createHtmlQuery(html) {
  const { parseDocument } = require('htmlparser2');
  const { findAll, findOne, getChildren, getInnerHTML, getName, getText, isTag } = require('domutils');
  const document = parseDocument(html);
  const body = findOne(node => isTag(node) && getName(node) === 'body', getChildren(document), true) || document;

  function collection(elements) {
    return {
      each(callback) {
        elements.forEach((element, index) => callback(index, element));
      }
    };
  }

  function wrap(element) {
    return {
      text: () => getText(element),
      html: () => getInnerHTML(element),
      find(selector) {
        const names = new Set(selector.split(',').map(name => name.trim().toLowerCase()));
        return collection(findAll(node => isTag(node) && names.has(getName(node)), getChildren(element)));
      }
    };
  }

  return target => {
    if (target === 'body') {
      return { children: () => collection(getChildren(body).filter(isTag)) };
    }
    return wrap(target);
  };
}

// ============================================================
// 第一部分：结构化解析函数
// ============================================================

/**
 * 解析 Word 文件（结构化版本）
 * @param {string} filePath - 文件路径
 * @returns {Array} 结构化节点数组
 */
async function parseWordStructured(filePath) {
  try {
    const mammoth = require('mammoth'); // 需要安装：npm install mammoth
    
    // 使用 mammoth 转换为 HTML（使用 buffer 方式避免 File API 问题）
    const fileBuffer = fs.readFileSync(filePath);
    const result = await mammoth.convertToHtml({ buffer: fileBuffer });
    const html = result.value;
    
    // 使用 cheerio 解析 HTML DOM
    const $ = createHtmlQuery(html);
    
    // 结构化节点数组
    const nodes = [];
    // 标题路径栈，用于维护当前章节层级
    const headingPathStack = [];
    
    // 遍历所有元素
    $('body').children().each((index, element) => {
      const el = $(element);
      const tagName = element.tagName.toLowerCase();
      
      // 处理标题
      if (['h1', 'h2', 'h3', 'h4'].includes(tagName)) {
        const level = parseInt(tagName.charAt(1));
        const content = el.text().trim();
        
        if (!content) return;
        
        // 更新标题路径栈：移除比当前层级更深的标题
        while (headingPathStack.length >= level) {
          headingPathStack.pop();
        }
        headingPathStack.push(content);
        
        nodes.push({
          type: NODE_TYPES.HEADING,
          level: level,
          content: content,
          path: [...headingPathStack],
          rawHtml: null
        });
      }
      
      // 处理段落
      else if (tagName === 'p') {
        const content = el.text().trim();
        if (!content) return;
        
        nodes.push({
          type: NODE_TYPES.PARAGRAPH,
          level: null,
          content: content,
          path: [...headingPathStack],
          rawHtml: null
        });
      }
      
      // 处理表格
      else if (tagName === 'table') {
        const rows = [];
        el.find('tr').each((trIndex, trElement) => {
          const cells = [];
          $(trElement).find('td, th').each((cellIndex, cellElement) => {
            cells.push($(cellElement).text().trim());
          });
          if (cells.length > 0) {
            rows.push(cells);
          }
        });
        
        if (rows.length === 0) return;
        
        // 表格内容：将行列转为文本
        const content = rows.map(row => row.join(' | ')).join('\n');
        
        nodes.push({
          type: NODE_TYPES.TABLE,
          level: null,
          content: content,
          path: [...headingPathStack],
          rawHtml: el.html()
        });
      }
      
      // 处理有序列表
      else if (tagName === 'ol') {
        const items = [];
        el.find('li').each((liIndex, liElement) => {
          items.push($(liElement).text().trim());
        });
        
        if (items.length === 0) return;
        
        nodes.push({
          type: NODE_TYPES.LIST,
          level: null,
          content: items.map((item, idx) => `${idx + 1}. ${item}`).join('\n'),
          path: [...headingPathStack],
          rawHtml: el.html(),
          listType: 'ordered',
          itemCount: items.length
        });
      }
      
      // 处理无序列表
      else if (tagName === 'ul') {
        const items = [];
        el.find('li').each((liIndex, liElement) => {
          items.push($(liElement).text().trim());
        });
        
        if (items.length === 0) return;
        
        nodes.push({
          type: NODE_TYPES.LIST,
          level: null,
          content: items.map(item => `- ${item}`).join('\n'),
          path: [...headingPathStack],
          rawHtml: el.html(),
          listType: 'unordered',
          itemCount: items.length
        });
      }
    });
    
    console.log('Word结构化解析完成，节点数量:', nodes.length);
    return nodes;
    
  } catch (error) {
    console.error('Word结构化解析失败:', error.message);
    throw new Error('Word结构化解析失败，请确保安装了 mammoth 和 htmlparser2 库');
  }
}

/**
 * 解析 PDF 文件（结构化版本）
 * @param {string} filePath - 文件路径
 * @returns {Array} 结构化节点数组
 */
async function parsePDFStructured(filePath) {
  try {
    const pdfParse = require('pdf-parse'); // 需要安装：npm install pdf-parse
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    const text = data.text;
    
    console.log('PDF原始文本长度:', text ? text.length : 0);
    console.log('PDF页数:', data.numpages || '未知');
    
    // 如果提取不到文本，可能是扫描版PDF
    if (!text || text.trim().length === 0) {
      console.warn('警告：PDF未提取到文本内容，可能是扫描版（图片PDF）');
      console.warn('建议：使用OCR工具处理扫描版PDF，或选择其他格式文档');
      // 返回一个提示节点
      return [{
        type: NODE_TYPES.PARAGRAPH,
        level: null,
        content: `[PDF解析提示] 该文档可能是扫描版（图片PDF），无法提取文本内容。文档名：${path.basename(filePath)}`,
        path: [path.basename(filePath)],
        rawHtml: null
      }];
    }
    
    const nodes = [];
    const headingPathStack = [];
    
    // 按段落分割
    const paragraphs = text.split(/\n\s*\n/);
    console.log('段落分割数量:', paragraphs.length);
    
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      
      // 检测是否为标题
      let isHeading = false;
      let headingLevel = 1;
      let headingContent = trimmed;
      
      // 匹配数字编号标题（如 1.2 XXX）
      const numberMatch = trimmed.match(/^(\d+(?:\.\d+)*)[\s\t]+(.+)$/);
      if (numberMatch) {
        isHeading = true;
        headingLevel = numberMatch[1].split('.').length;
        headingContent = numberMatch[2];
        
        while (headingPathStack.length >= headingLevel) {
          headingPathStack.pop();
        }
        headingPathStack.push(headingContent);
      }
      
      // 匹配中文章节标题（如 第一章 XXX）
      const chapterMatch = trimmed.match(/^第[一二三四五六七八九十]+[章节部篇]\s+(.+)$/);
      if (chapterMatch) {
        isHeading = true;
        headingLevel = 1;
        headingContent = chapterMatch[1];
        
        while (headingPathStack.length >= headingLevel) {
          headingPathStack.pop();
        }
        headingPathStack.push(headingContent);
      }
      
      if (isHeading) {
        nodes.push({
          type: NODE_TYPES.HEADING,
          level: headingLevel,
          content: headingContent,
          path: [...headingPathStack],
          rawHtml: null
        });
      } else {
        nodes.push({
          type: NODE_TYPES.PARAGRAPH,
          level: null,
          content: trimmed,
          path: [...headingPathStack],
          rawHtml: null
        });
      }
    }
    
    console.log('PDF结构化解析完成，节点数量:', nodes.length);
    return nodes;
    
  } catch (error) {
    console.error('PDF结构化解析失败:', error.message);
    throw new Error('PDF结构化解析失败，请确保安装了 pdf-parse 库');
  }
}

/**
 * 解析 Excel 文件（结构化版本）
 * @param {string} filePath - 文件路径
 * @returns {Array} 结构化节点数组
 */
async function parseExcelStructured(filePath) {
  try {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    
    const nodes = [];
    
    workbook.eachSheet((sheet) => {
      const sheetName = sheet.name;
      const jsonData = [];
      sheet.eachRow({ includeEmpty: false }, row => {
        jsonData.push(row.values.slice(1).map(value => {
          if (value && typeof value === 'object' && 'result' in value) return value.result;
          if (value && typeof value === 'object' && Array.isArray(value.richText)) {
            return value.richText.map(part => part.text || '').join('');
          }
          return value;
        }));
      });
      
      if (jsonData.length === 0) return;
      
      // 提取表头
      const headers = jsonData[0] || [];
      
      // 表格内容
      const rows = jsonData.slice(1).map(row => 
        row.map(cell => (cell !== undefined && cell !== null ? String(cell) : '')).join(' | ')
      );
      
      const content = rows.join('\n');
      
      nodes.push({
        type: NODE_TYPES.SHEET,
        level: null,
        content: content,
        path: [sheetName],
        rawHtml: null,
        sheetName: sheetName,
        headers: headers,
        rowCount: jsonData.length - 1,
        colCount: headers.length
      });
    });
    
    console.log('Excel结构化解析完成，Sheet数量:', nodes.length);
    return nodes;
    
  } catch (error) {
    console.error('Excel结构化解析失败:', error.message);
    throw new Error('Excel结构化解析失败，请确保安装了 xlsx 库');
  }
}

/**
 * 解析 TXT 文件（结构化版本）
 * @param {string} filePath - 文件路径
 * @returns {Array} 结构化节点数组
 */
async function parseTXTStructured(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    const nodes = [];
    const headingPathStack = [];
    
    // 按段落分割
    const paragraphs = content.split(/\n\s*\n/);
    
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      
      // 检测是否为标题（行较短且以数字编号开头）
      const headingMatch = trimmed.match(/^(\d+(?:\.\d+)*)[\s\t]+(.+)$/);
      
      if (headingMatch && trimmed.length < 100) {
        const level = headingMatch[1].split('.').length;
        const headingContent = headingMatch[2];
        
        while (headingPathStack.length >= level) {
          headingPathStack.pop();
        }
        headingPathStack.push(headingContent);
        
        nodes.push({
          type: NODE_TYPES.HEADING,
          level: level,
          content: headingContent,
          path: [...headingPathStack],
          rawHtml: null
        });
      } else {
        nodes.push({
          type: NODE_TYPES.PARAGRAPH,
          level: null,
          content: trimmed,
          path: [...headingPathStack],
          rawHtml: null
        });
      }
    }
    
    console.log('TXT结构化解析完成，节点数量:', nodes.length);
    return nodes;
    
  } catch (error) {
    console.error('TXT结构化解析失败:', error.message);
    throw new Error('TXT文件读取失败');
  }
}

/**
 * 解析 Markdown 文件（结构化版本）
 * 识别 # / ## / ### 标题语法，以及 | 表格语法、- / * 列表语法
 * @param {string} filePath - 文件路径
 * @returns {Array} 结构化节点数组
 */
async function parseMarkdownStructured(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    const nodes = [];
    const headingPathStack = [];
    
    // 按行处理，识别 Markdown 语法
    const lines = content.split('\n');
    let currentParagraph = [];
    let currentTableRows = [];
    let currentListItems = [];
    let listType = null; // 'ordered' | 'unordered'
    
    /**
     * 将累积的段落文本作为 PARAGRAPH 节点推入
     */
    function flushParagraph() {
      if (currentParagraph.length > 0) {
        const text = currentParagraph.join('\n').trim();
        if (text) {
          nodes.push({
            type: NODE_TYPES.PARAGRAPH,
            level: null,
            content: text,
            path: [...headingPathStack],
            rawHtml: null
          });
        }
        currentParagraph = [];
      }
    }
    
    /**
     * 将累积的表格行作为 TABLE 节点推入
     */
    function flushTable() {
      if (currentTableRows.length > 0) {
        const tableContent = currentTableRows.join('\n');
        nodes.push({
          type: NODE_TYPES.TABLE,
          level: null,
          content: tableContent,
          path: [...headingPathStack],
          rawHtml: null
        });
        currentTableRows = [];
      }
    }
    
    /**
     * 将累积的列表项作为 LIST 节点推入
     */
    function flushList() {
      if (currentListItems.length > 0) {
        const formatted = listType === 'ordered'
          ? currentListItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
          : currentListItems.map(item => `- ${item}`).join('\n');
        nodes.push({
          type: NODE_TYPES.LIST,
          level: null,
          content: formatted,
          path: [...headingPathStack],
          rawHtml: null,
          listType: listType,
          itemCount: currentListItems.length
        });
        currentListItems = [];
        listType = null;
      }
    }
    
    /**
     * 刷新所有累积缓冲
     */
    function flushAll() {
      flushParagraph();
      flushTable();
      flushList();
    }
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // 空行：刷新当前累积
      if (!trimmed) {
        flushAll();
        continue;
      }
      
      // 1. Markdown 标题检测：# ~ ######
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushAll();
        const level = headingMatch[1].length;
        const headingContent = headingMatch[2].trim();
        
        // 更新标题路径栈
        while (headingPathStack.length >= level) {
          headingPathStack.pop();
        }
        headingPathStack.push(headingContent);
        
        nodes.push({
          type: NODE_TYPES.HEADING,
          level: level,
          content: headingContent,
          path: [...headingPathStack],
          rawHtml: null
        });
        continue;
      }
      
      // 2. 数字编号标题检测（兼容非标准 Markdown，如 "1.2 标题"）
      const numberHeadingMatch = trimmed.match(/^(\d+(?:\.\d+)*)[\s\t]+(.+)$/);
      if (numberHeadingMatch && trimmed.length < 100 && !trimmed.match(/^\d+\.\s/)) {
        flushAll();
        const level = numberHeadingMatch[1].split('.').length;
        const headingContent = numberHeadingMatch[2];
        
        while (headingPathStack.length >= level) {
          headingPathStack.pop();
        }
        headingPathStack.push(headingContent);
        
        nodes.push({
          type: NODE_TYPES.HEADING,
          level: level,
          content: headingContent,
          path: [...headingPathStack],
          rawHtml: null
        });
        continue;
      }
      
      // 3. Markdown 表格检测：含 | 的行
      if (trimmed.includes('|')) {
        // 分隔行检测（如 |---|---|）
        if (trimmed.match(/^\|?[\s-:|]+\|[\s-:|]*$/)) {
          // 跳过分隔行，表格行已收集
          continue;
        }
        
        // 如果当前有段落或列表在累积，先刷新
        if (currentParagraph.length > 0 || currentListItems.length > 0) {
          flushParagraph();
          flushList();
        }
        
        // 解析表格行
        const cells = trimmed.split('|')
          .map(c => c.trim())
          .filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''));
        
        if (cells.length > 0) {
          currentTableRows.push(cells.join(' | '));
        }
        continue;
      }
      
      // 4. 无序列表检测：- / * / + 开头
      const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
      if (unorderedMatch) {
        flushParagraph();
        flushTable();
        if (listType && listType !== 'unordered') {
          flushList();
        }
        listType = 'unordered';
        currentListItems.push(unorderedMatch[1]);
        continue;
      }
      
      // 5. 有序列表检测：1. / 2. 等
      const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (orderedMatch) {
        flushParagraph();
        flushTable();
        if (listType && listType !== 'ordered') {
          flushList();
        }
        listType = 'ordered';
        currentListItems.push(orderedMatch[1]);
        continue;
      }
      
      // 6. 普通段落文本
      // 如果当前有表格或列表在累积，先刷新
      if (currentTableRows.length > 0 || currentListItems.length > 0) {
        flushAll();
      }
      currentParagraph.push(trimmed);
    }
    
    // 处理文件末尾剩余内容
    flushAll();
    
    console.log('Markdown结构化解析完成，节点数量:', nodes.length);
    return nodes;
    
  } catch (error) {
    console.error('Markdown结构化解析失败:', error.message);
    throw new Error('Markdown文件读取失败');
  }
}

/**
 * 解析 PPT 文件（结构化版本，基础实现）
 * @param {string} filePath - 文件路径
 * @returns {Array} 结构化节点数组
 */
async function parsePPTStructured(filePath) {
  console.warn('PPT结构化解析功能待完善');
  
  const ext = path.extname(filePath).toLowerCase();
  const nodes = [];
  
  if (ext === '.pptx') {
    nodes.push({
      type: NODE_TYPES.HEADING,
      level: 1,
      content: path.basename(filePath),
      path: [path.basename(filePath)],
      rawHtml: null
    });
    
    nodes.push({
      type: NODE_TYPES.PARAGRAPH,
      level: null,
      content: 'PPT内容解析需要安装专门的解析库',
      path: [path.basename(filePath)],
      rawHtml: null
    });
  }
  
  return nodes;
}

/**
 * 根据文件类型选择结构化解析方法
 * @param {string} filePath - 文件路径
 * @param {string} fileType - 文件类型（扩展名）
 * @returns {Array} 结构化节点数组
 */
async function parseDocument(filePath, fileType) {
  const ext = fileType.toLowerCase();
  
  switch (ext) {
    case '.pdf':
      return await parsePDFStructured(filePath);
    case '.doc':
    case '.docx':
      return await parseWordStructured(filePath);
    case '.xls':
    case '.xlsx':
      return await parseExcelStructured(filePath);
    case '.txt':
      return await parseTXTStructured(filePath);
    case '.md':
      return await parseMarkdownStructured(filePath);
    case '.ppt':
    case '.pptx':
      return await parsePPTStructured(filePath);
    default:
      throw new Error(`不支持的文件类型: ${ext}`);
  }
}

// ============================================================
// 第二部分：模板化策略分块
// ============================================================

/**
 * 模板化策略分块
 * @param {Array} structuredNodes - 结构化节点数组
 * @param {Object} template - 分块模板配置
 * @param {string} sourceFileName - 源文件名
 * @returns {Array} 分块数组
 */
function splitByTemplate(structuredNodes, template = defaultTemplate, sourceFileName = '', knowledgeMetadata = {}) {
  const chunks = [];
  const normalizedKnowledgeMetadata = normalizeKnowledgeMetadata(knowledgeMetadata);
  
  let currentChunk = {
    content: '',
    metadata: {
      chapterPath: [],
      chunkType: 'paragraph',
      sourceFileName: sourceFileName,
      knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
      knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
    }
  };
  
  let currentChapterPath = [];
  
  for (const node of structuredNodes) {
    // 1. 标题驱动拆分
    if (node.type === NODE_TYPES.HEADING) {
      if (node.level <= template.maxHeadingLevel) {
        if (currentChunk.content.trim()) {
          chunks.push({
            content: currentChunk.content.trim(),
            index: chunks.length,
            metadata: currentChunk.metadata
          });
        }
        
        currentChapterPath = node.path;
        currentChunk = {
          content: '',
          metadata: {
            chapterPath: [...currentChapterPath],
            chunkType: 'paragraph',
            sourceFileName: sourceFileName,
            knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
            knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
          }
        };
      } else {
        currentChapterPath = node.path;
      }
      continue;
    }
    
    // 2. 表格整块保留
    if (node.type === NODE_TYPES.TABLE && template.keepTableWhole) {
      if (currentChunk.content.trim()) {
        chunks.push({
          content: currentChunk.content.trim(),
          index: chunks.length,
          metadata: currentChunk.metadata
        });
        currentChunk = {
          content: '',
          metadata: {
            chapterPath: [...currentChapterPath],
            chunkType: 'paragraph',
            sourceFileName: sourceFileName,
            knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
            knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
          }
        };
      }
      
      let tableContent = node.content;
      if (template.injectHeadingPath && currentChapterPath.length > 0) {
        const pathPrefix = currentChapterPath.join(' > ');
        tableContent = `${pathPrefix}\n【表格内容】\n${tableContent}`;
      }
      
      chunks.push({
        content: tableContent,
        index: chunks.length,
        metadata: {
          chapterPath: [...currentChapterPath],
          chunkType: 'table',
          sourceFileName: sourceFileName,
          knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
          knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
        }
      });
      continue;
    }
    
    // 3. 短列表整块保留
    if (node.type === NODE_TYPES.LIST && template.keepListWhole) {
      const itemCount = node.itemCount || 0;
      
      if (itemCount <= template.maxListLength) {
        if (currentChunk.content.trim()) {
          chunks.push({
            content: currentChunk.content.trim(),
            index: chunks.length,
            metadata: currentChunk.metadata
          });
          currentChunk = {
            content: '',
            metadata: {
              chapterPath: [...currentChapterPath],
              chunkType: 'paragraph',
              sourceFileName: sourceFileName,
              knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
              knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
            }
          };
        }
        
        let listContent = node.content;
        if (template.injectHeadingPath && currentChapterPath.length > 0) {
          const pathPrefix = currentChapterPath.join(' > ');
          listContent = `${pathPrefix}\n${listContent}`;
        }
        
        chunks.push({
          content: listContent,
          index: chunks.length,
          metadata: {
            chapterPath: [...currentChapterPath],
            chunkType: 'list',
            sourceFileName: sourceFileName,
            knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
            knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
          }
        });
        continue;
      }
    }
    
    // 4. Sheet 整块保留
    if (node.type === NODE_TYPES.SHEET) {
      if (currentChunk.content.trim()) {
        chunks.push({
          content: currentChunk.content.trim(),
          index: chunks.length,
          metadata: currentChunk.metadata
        });
        currentChunk = {
          content: '',
          metadata: {
            chapterPath: [],
            chunkType: 'paragraph',
            sourceFileName: sourceFileName,
            knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
            knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
          }
        };
      }
      
      let sheetContent = `【Sheet: ${node.sheetName}】\n`;
      if (node.headers && node.headers.length > 0) {
        sheetContent += `表头: ${node.headers.join(' | ')}\n`;
      }
      sheetContent += node.content;
      
      chunks.push({
        content: sheetContent,
        index: chunks.length,
        metadata: {
          chapterPath: [node.sheetName],
          chunkType: 'sheet',
          sourceFileName: sourceFileName,
          knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
          knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
        }
      });
      continue;
    }
    
    // 5. 段落累积
    if (node.type === NODE_TYPES.PARAGRAPH || (node.type === NODE_TYPES.LIST && !template.keepListWhole)) {
      if (!currentChunk.content && template.injectHeadingPath && currentChapterPath.length > 0) {
        const pathPrefix = currentChapterPath.join(' > ');
        currentChunk.content = `${pathPrefix}\n`;
      }
      
      currentChunk.content += node.content + '\n';
      
      // 6. 超长兜底拆分
      if (currentChunk.content.length > template.maxChunkSize) {
        const subChunks = splitBySentenceBoundary(
          currentChunk.content,
          template.maxChunkSize,
          template.chunkOverlap
        );
        
        for (const subChunk of subChunks) {
          chunks.push({
            content: subChunk.trim(),
            index: chunks.length,
            metadata: {
              chapterPath: [...currentChapterPath],
              chunkType: 'paragraph',
              sourceFileName: sourceFileName,
              knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
              knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
            }
          });
        }
        
        currentChunk = {
          content: '',
          metadata: {
            chapterPath: [...currentChapterPath],
            chunkType: 'paragraph',
            sourceFileName: sourceFileName,
            knowledgeScope: normalizedKnowledgeMetadata.knowledgeScope,
            knowledgeChannels: normalizedKnowledgeMetadata.knowledgeChannels
          }
        };
      }
    }
  }
  
  // 结算最后一个分块
  if (currentChunk.content.trim()) {
    chunks.push({
      content: currentChunk.content.trim(),
      index: chunks.length,
      metadata: currentChunk.metadata
    });
  }
  
  return chunks;
}

/**
 * 按句子边界拆分（兜底方法）
 * @param {string} text - 文本内容
 * @param {number} maxSize - 最大字符数
 * @param {number} overlap - 重叠字符数
 * @returns {Array} 拆分后的文本片段
 */
function splitBySentenceBoundary(text, maxSize, overlap) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = Math.min(start + maxSize, text.length);
    
    if (end < text.length) {
      const sentenceEnds = ['.', '!', '?', '。', '！', '？', '\n'];
      let bestEnd = -1;
      
      for (const sep of sentenceEnds) {
        const pos = text.lastIndexOf(sep, end);
        if (pos > start && pos > bestEnd) {
          bestEnd = pos + 1;
        }
      }
      
      if (bestEnd > start) {
        end = bestEnd;
      }
    }
    
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    start = end - overlap > start ? end - overlap : end;
  }
  
  return chunks;
}

// ============================================================
// 第三部分：百炼流程（不依赖本地数据库，直接对接百炼向量索引）
// ============================================================

/**
 * 上传单个文本分块到百炼数据中心并加入索引
 * @param {Object} chunk - 分块对象
 * @param {string} chunkFileName - 分块文件名
 * @param {Object} client - 百炼客户端
 * @param {Object} runtime - 运行时配置
 * @returns {Object} 上传结果 { fileId, status }
 */
async function uploadChunkToBailian(chunk, chunkFileName, client, runtime) {
  // 1. 保存分块内容为临时文本文件
  const tempDir = './temp_chunks';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const tempFilePath = path.join(tempDir, chunkFileName);
  
  // 组装文件内容：包含元数据和分块内容
  const fileContent = `【来源文件】${chunk.metadata.sourceFileName || '未知'}
【章节路径】${chunk.metadata.chapterPath?.join('/') || '无'}
【分块类型】${chunk.metadata.chunkType || 'paragraph'}
【分块索引】${chunk.index || 0}
【适用范围】${chunk.metadata.knowledgeScope || 'common'}
【适用渠道】${(chunk.metadata.knowledgeChannels || ['all']).join(',')}

${chunk.content}`;
  
  fs.writeFileSync(tempFilePath, fileContent, 'utf8');
  
  // 2. 计算文件MD5和大小
  const fileBuffer = fs.readFileSync(tempFilePath);
  const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const fileSize = fs.statSync(tempFilePath).size;
  
  try {
    // 3. 申请文件上传租约
    const applyLeaseRequest = new Bailian20231229.ApplyFileUploadLeaseRequest({
      fileName: chunkFileName,
      md5: md5,
      sizeInBytes: fileSize.toString()
    });
    
    const leaseResponse = await client.applyFileUploadLeaseWithOptions(
      CATEGORY_ID,
      WORKSPACE_ID,
      applyLeaseRequest,
      {},
      runtime
    );
    
    const leaseData = leaseResponse.body.data;
    const leaseId = leaseData.fileUploadLeaseId;
    const uploadUrl = leaseData.param.url;
    const uploadHeaders = leaseData.param.headers;
    
    // 4. 上传文件到OSS
    await putFileToLeaseUrl(uploadUrl, tempFilePath, uploadHeaders);
    
    // 5. 提交文件到百炼数据中心
    const addFileRequest = new Bailian20231229.AddFileRequest({
      leaseId: leaseId,
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
    
    // 6. 删除临时文件
    fs.unlinkSync(tempFilePath);
    
    return { fileId, status: 'success', chunkFileName };
    
  } catch (error) {
    // 删除临时文件
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    throw error;
  }
}

/**
 * 分块上传到百炼数据中心并加入索引（方案2：分块作为文本文件上传）
 * @param {Array} chunks - 分块数组
 * @param {string} fileName - 源文件名
 * @returns {string} 索引任务ID
 */
async function uploadChunksToIndex(chunks, fileName) {
  console.log('========== 开始上传分块到百炼数据中心 ==========');
  console.log('分块数量:', chunks.length);
  console.log('源文件名:', fileName);
  
  const client = createBailianClient();
  const runtime = new Util.RuntimeOptions({});
  
  // 提取源文件名（不含扩展名）作为前缀
  const baseName = path.basename(fileName, path.extname(fileName));
  
  // 上传所有分块到百炼数据中心
  const fileIds = [];
  const batchSize = 5; // 每批处理5个分块，避免API限频
  
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batchChunks = chunks.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize) + 1;
    const totalBatch = Math.ceil(chunks.length / batchSize);
    
    console.log(`处理第 ${batchIndex}/${totalBatch} 批：${batchChunks.length} 个分块`);
    
    // 并行上传当前批次的分块
    const batchResults = await Promise.allSettled(
      batchChunks.map((chunk, j) => {
        const chunkFileName = `${baseName}_chunk_${i + j + 1}.txt`;
        return uploadChunkToBailian(chunk, chunkFileName, client, runtime);
      })
    );
    
    // 收集成功上传的文件ID
    batchResults.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        fileIds.push(result.value.fileId);
        console.log(`分块 ${i + j + 1} 上传成功，fileId: ${result.value.fileId}`);
      } else {
        console.error(`分块 ${i + j + 1} 上传失败: ${result.reason?.message || '未知错误'}`);
      }
    });
    
    // 批次间隔 500ms，避免API限频
    if (i + batchSize < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  console.log(`分块上传完成：成功 ${fileIds.length} 个，失败 ${chunks.length - fileIds.length} 个`);
  
  if (fileIds.length === 0) {
    throw new Error('所有分块上传失败，无法加入索引');
  }
  
  // 提交索引任务：将上传的文件加入知识库索引
  console.log('========== 提交索引任务 ==========');
  console.log('文件ID数量:', fileIds.length);
  
  const indexRequest = new Bailian20231229.SubmitIndexAddDocumentsJobRequest({
    indexId: INDEX_ID,
    sourceType: 'DATA_CENTER_FILE',
    documentIds: fileIds
  });
  
  const indexResponse = await client.submitIndexAddDocumentsJobWithOptions(
    WORKSPACE_ID,
    indexRequest,
    {},
    runtime
  );
  
  console.log('索引任务响应:', JSON.stringify(indexResponse.body, null, 2));
  
  if (!indexResponse.body.success) {
    throw new Error(`索引任务提交失败: ${indexResponse.body.message || '未知错误'}`);
  }
  
  const jobId = indexResponse.body.data?.id;
  console.log('========== 索引任务提交成功 ==========');
  console.log('jobId:', jobId);
  console.log('上传文件数:', fileIds.length);
  
  return jobId;
}

/**
 * 轮询索引任务状态
 * @param {string} jobId - 索引任务ID
 * @param {number} maxRetry - 最大轮询次数，默认30次（约60秒）
 * @returns {string} 最终状态
 */
async function pollIndexJobStatus(jobId, maxRetry = 30) {
  console.log('开始轮询索引任务状态，jobId:', jobId);
  
  const client = createBailianClient();
  const runtime = new Util.RuntimeOptions({});
  
  for (let retry = 1; retry <= maxRetry; retry++) {
    // 查询任务状态
    const request = new Bailian20231229.DescribeIndexAddDocumentsJobRequest({});
    
    const response = await client.describeIndexAddDocumentsJobWithOptions(
      WORKSPACE_ID,
      jobId,
      request,
      {},
      runtime
    );
    
    const status = response.body.data?.status;
    console.log(`轮询第 ${retry}/${maxRetry} 次：状态 ${status}`);
    
    // 判断状态
    if (status === 'SUCCEEDED') {
      console.log('索引任务完成：SUCCEEDED');
      return 'SUCCEEDED';
    }
    
    if (status === 'FAILED') {
      const errorMsg = response.body.data?.errorMessage || '未知错误';
      console.error('索引任务失败：', errorMsg);
      throw new Error(`索引任务失败: ${errorMsg}`);
    }
    
    // 等待 2 秒后继续轮询
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // 超时
  console.error('索引任务轮询超时');
  throw new Error(`索引任务轮询超时：已轮询 ${maxRetry} 次`);
}

/**
 * Demo 一键全流程入口函数
 * @param {string} filePath - 文件路径
 * @param {string} originalFileName - 原始文件名（可选，缺省时从路径提取）
 * @param {Object} options - 可选参数
 * @param {Object} options.template - 分块模板，默认使用 defaultTemplate
 * @param {boolean} options.waitForIndex - 是否等待索引完成，默认 false
 * @returns {Object} 处理结果 { fileName, chunkCount, jobId, chunks }
 */
async function processAndUploadToIndex(filePath, originalFileName, options = {}) {
  const {
    template = defaultTemplate,
    waitForIndex = false,
    knowledgeMetadata = {}
  } = options;
  
  // 1. 校验文件存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  
  // 2. 提取文件名（如果未提供）
  const fileName = originalFileName || path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  
  console.log('========== Demo 全流程开始 ==========');
  console.log('文件路径:', filePath);
  console.log('文件名:', fileName);
  console.log('文件类型:', ext);
  
  // 3. 结构化解析
  console.log('1. 正在结构化解析...');
  const structuredNodes = await parseDocument(filePath, ext);
  console.log('结构化解析完成，节点数量:', structuredNodes.length);
  
  // 4. 模板化分块
  console.log('2. 正在模板化分块...');
  const chunks = splitByTemplate(structuredNodes, template, fileName, knowledgeMetadata);
  console.log('分块完成，总块数:', chunks.length);
  
  // 5. 分块统计
  const chunkTypeCount = {};
  chunks.forEach(c => {
    const type = c.metadata?.chunkType || 'unknown';
    chunkTypeCount[type] = (chunkTypeCount[type] || 0) + 1;
  });
  console.log('分块统计:', JSON.stringify(chunkTypeCount));
  
  // 6. 写入百炼索引
  console.log('3. 正在写入百炼索引...');
  const jobId = await uploadChunksToIndex(chunks, fileName);
  
  // 7. 可选：等待索引完成
  if (waitForIndex) {
    console.log('4. 等待索引完成...');
    await pollIndexJobStatus(jobId, 30);
  }
  
  console.log('========== Demo 全流程完成 ==========');
  
  // 8. 返回结果
  return {
    fileName,
    chunkCount: chunks.length,
    jobId,
    chunks: chunks.map(c => ({
      content: c.content,
      index: c.index,
      metadata: c.metadata
    })),
    structuredNodes: structuredNodes.length
  };
}

/**
 * 预览分块（只做解析和分块，不上传）
 * 用于前端预览，用户确认后再上传
 * @param {string} filePath - 文件路径
 * @param {string} originalFileName - 原始文件名
 * @param {Object} options - 可选参数
 * @returns {Object} 预览结果 { fileName, chunks, structuredNodes, chunkStats }
 */
async function previewChunks(filePath, originalFileName, options = {}) {
  const { template = defaultTemplate, knowledgeMetadata = {} } = options;
  
  // 1. 校验文件存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  
  // 2. 提取文件名
  const fileName = originalFileName || path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  
  console.log('========== 预览分块开始 ==========');
  console.log('文件名:', fileName);
  console.log('文件类型:', ext);
  
  // 3. 结构化解析
  console.log('正在结构化解析...');
  const structuredNodes = await parseDocument(filePath, ext);
  console.log('结构化解析完成，节点数量:', structuredNodes.length);
  
  // 4. 模板化分块
  console.log('正在模板化分块...');
  const chunks = splitByTemplate(structuredNodes, template, fileName, knowledgeMetadata);
  console.log('分块完成，总块数:', chunks.length);
  
  // 5. 分块统计
  const chunkStats = {
    total: chunks.length,
    byType: {},
    avgLength: 0,
    maxLength: 0,
    minLength: Infinity
  };
  
  chunks.forEach(c => {
    const type = c.metadata?.chunkType || 'paragraph';
    chunkStats.byType[type] = (chunkStats.byType[type] || 0) + 1;
    const len = c.content?.length || 0;
    chunkStats.avgLength += len;
    chunkStats.maxLength = Math.max(chunkStats.maxLength, len);
    chunkStats.minLength = Math.min(chunkStats.minLength, len);
  });
  
  if (chunks.length > 0) {
    chunkStats.avgLength = Math.round(chunkStats.avgLength / chunks.length);
  }
  if (chunkStats.minLength === Infinity) {
    chunkStats.minLength = 0;
  }
  
  console.log('分块统计:', JSON.stringify(chunkStats));
  console.log('========== 预览分块完成 ==========');
  
  // 6. 返回预览结果（包含完整分块数据，供后续确认上传使用）
  return {
    fileName,
    chunks: chunks.map(c => ({
      content: c.content,
      index: c.index,
      metadata: c.metadata
    })),
    structuredNodes: structuredNodes.length,
    chunkStats,
    // 保留原始结构化节点，供用户查看
    structuredNodesPreview: structuredNodes.slice(0, 20).map(n => ({
      type: n.type,
      level: n.level,
      content: n.content?.substring(0, 100) + (n.content?.length > 100 ? '...' : ''),
      path: n.path
    }))
  };
}

/**
 * 确认上传分块（接收预览数据，上传到百炼）
 * @param {Array} chunks - 分块数组（从预览结果传入）
 * @param {string} fileName - 文件名
 * @param {Object} options - 可选参数
 * @returns {Object} 上传结果 { jobId, uploadedCount }
 */
async function confirmUploadChunks(chunks, fileName, options = {}) {
  const { waitForIndex = false } = options;
  
  if (!chunks || chunks.length === 0) {
    throw new Error('分块数据为空，无法上传');
  }
  
  console.log('========== 确认上传分块开始 ==========');
  console.log('文件名:', fileName);
  console.log('分块数量:', chunks.length);
  
  // 上传到百炼索引
  const jobId = await uploadChunksToIndex(chunks, fileName);
  
  // 可选：等待索引完成
  if (waitForIndex) {
    console.log('等待索引完成...');
    await pollIndexJobStatus(jobId, 30);
  }
  
  console.log('========== 确认上传分块完成 ==========');
  
  return {
    jobId,
    uploadedCount: chunks.length,
    fileName
  };
}

// ============================================================
// 第六部分：导出模块
// ============================================================

module.exports = {
  createHtmlQuery,
  // 结构化解析函数
  parseDocument,
  parsePDFStructured,
  parseWordStructured,
  parseExcelStructured,
  parseTXTStructured,
  parseMarkdownStructured,
  parsePPTStructured,
  
  // 模板化分块函数
  splitByTemplate,
  splitBySentenceBoundary,
  defaultTemplate,
  NODE_TYPES,
  
  // 百炼索引相关函数
  uploadChunksToIndex, // 分块上传到百炼数据中心
  pollIndexJobStatus,
  processAndUploadToIndex, // 一键完整流程
  previewChunks, // 预览分块（只解析，不上传）
  confirmUploadChunks, // 确认上传（接收预览数据上传）
  
  // 百炼客户端（供外部复用）
  createBailianClient,
  WORKSPACE_ID,
  INDEX_ID
};
