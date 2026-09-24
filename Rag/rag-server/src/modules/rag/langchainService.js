require('dotenv').config();
const { ChatOpenAI } = require('@langchain/openai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence, RunnablePassthrough } = require('@langchain/core/runnables');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { createAgent, humanInTheLoopMiddleware } = require('langchain');
const { Command } = require('@langchain/langgraph');
const { SequelizeCheckpointer } = require('./SequelizeCheckpointer');
const { DANGEROUS_TOOLS } = require('./tools');
const { z } = require('zod');

// ========== 配置项 ==========
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// ========== 定义 Context Schema（不会被持久化）==========
// 使用对象结构存储 RAG 参考资料，避免污染 messages 历史
const contextSchema = z.object({
  ragContext: z.string().optional().describe('RAG 参考资料，不会持久化到历史'),
});

// ========== LangChain Agent 状态管理 =====
let agentInstance = null;
let checkpointerInstance = null;

function getOrCreateAgent(model, tools = []) {
  if (!agentInstance) {
    checkpointerInstance = new SequelizeCheckpointer();

    // ===== 基础系统提示词（不含动态资料） =====
    const BASE_SYSTEM_PROMPT = `你是一个智能助理，具备**查阅操作手册（RAG）** 和 **调用外部工具（Tools）** 的能力。

请遵循以下核心逻辑（Chain of Thought）：

1. **意图分析与规则加载**
   - 理解用户的目标。
   【强制规则】如果系统提供了【参考资料】，你必须严格按照资料中的文字描述回答。如果资料中查不到，直接回复"手册中未找到相关条款"，严禁使用你训练数据中的通用知识。

2. **任务规划与工具调用**
   - 根据手册要求或常识，列出完成任务所需的步骤。
   - **自主决策**调用提供的工具（Tools）。不要猜测工具返回的数据，必须基于工具返回的**真实结果**进行下一步操作。
   - 如果任务复杂，分步执行（先查数据 -> 处理数据 -> 执行提交）。

3. **异常与兜底处理**
   - 如果工具执行失败或未找到数据，如实告知用户，不要编造信息。
   - 如果资料（RAG）和你的常识冲突，**优先遵循资料**。

4. **最终反馈**
   - 整合工具返回的数据，以清晰、结构化（如列表、分点）的方式回复用户。`;

    // ===== 自定义中间件：在 beforeModel 中直接替换系统消息 =====
    // 避免使用 dynamicSystemPromptMiddleware，因为它的 concat 方法会将 content 转为数组
    // 阿里云百炼 API 只接受字符串格式的 content
    const ragContextMiddleware = {
      beforeModel: async (state, runtime) => {
        // 从 runtime.configurable 中获取参考资料（配置字段不会被持久化到 checkpoint）
        const contextText = runtime?.configurable?.ragContext || runtime?.context?.ragContext || '';
        console.log('[Middleware] 收到上下文长度:', contextText.length, '是否有内容:', contextText.length > 0);

        // 构建完整的系统提示词
        const fullSystemPrompt = contextText
          ? `${BASE_SYSTEM_PROMPT}\n\n【当前参考资料】\n${contextText}`
          : BASE_SYSTEM_PROMPT;

        // 获取当前消息列表
        const messages = state.messages || [];

        // 找到系统消息的位置并替换（不触发 concat）
        const systemMessageIndex = messages.findIndex(
          (m) => m._getType?.() === 'system' || m.role === 'system'
        );

        if (systemMessageIndex !== -1) {
          // 替换现有的系统消息（content 保持为字符串）
          messages[systemMessageIndex] = new SystemMessage({
            content: fullSystemPrompt,
          });
        } else {
          // 如果不存在系统消息（理论上 createAgent 会有一个空的），则插入
          messages.unshift(new SystemMessage({ content: fullSystemPrompt }));
        }

        // 返回更新后的消息列表
        return {
          messages: messages,
        };
      },
    };

    // ===== HITL 中间件：危险桌面操作需用户确认 =====
    const hitlConfig = {};
    for (const toolName of DANGEROUS_TOOLS) {
      hitlConfig[toolName] = {
        allowedDecisions: ['approve', 'reject'],
        description: `⚠️ 即将执行桌面操作: ${toolName}。请确认是否继续。`,
      };
    }
    const hitlMiddleware = humanInTheLoopMiddleware({
      interruptOn: hitlConfig,
      descriptionPrefix: '桌面自动化操作需要审批',
    });

    agentInstance = createAgent({
      model: model,
      tools: tools,
      contextSchema: contextSchema,
      middleware: [ragContextMiddleware, hitlMiddleware],
      checkpointer: checkpointerInstance,
    });
  }
  return { agent: agentInstance, checkpointer: checkpointerInstance };
}

// ========== 初始化 LangChain ChatOpenAI（阿里云百炼兼容模式） ==========
function createChatModel(options = {}) {
  const {
    model = 'qwen-plus',
    temperature = 0.7,
    maxTokens = 2000,
    streaming = false
  } = options;

  return new ChatOpenAI({
    model: model,
    temperature,
    maxTokens,
    streaming,
    apiKey: process.env.DASHSCOPE_API_KEY,
    configuration: {
      baseURL: DASHSCOPE_BASE_URL
    }
  });
}

// ========== 增强版 RAG 流式对话（统一接口）==========
/**
 * 增强版 RAG 流式对话：支持知识库检索、会话状态管理、流式输出、上下文截断
 * 使用 contextSchema 存储参考资料（不持久化），dynamicSystemPrompt 注入到系统提示词
 * @param {string} query - 用户问题
 * @param {string} threadId - 会话线程ID，用于隔离不同会话
 * @param {Array} contextDocs - 知识库检索结果 [{ text, docName }]
 * @param {Object} options - 配置选项 { model, temperature, maxContextTokens, tools }
 * @returns {AsyncIterator} 流式输出迭代器
 */
async function enhancedRagChatStream(query, threadId, contextDocs = [], options = {}) {
  const { model = 'qwen-plus', temperature = 0.7, maxContextTokens = 2000, tools = [] } = options;

  const chatModel = createChatModel({ model, temperature, streaming: true });

  // 构建上下文（不注入到 messages，而是通过 context 传递）
  let contextText = '';
  if (contextDocs && contextDocs.length > 0) {
    contextText = '【参考资料】\n以下是从知识库检索到的相关信息，请参考这些内容回答问题：\n\n';
    let totalLength = contextText.length;
    for (const doc of contextDocs) {
      const docContent = `[来源：${doc.docName || '未知'}]\n${doc.text}\n\n`;
      if (totalLength + docContent.length > maxContextTokens) {
        contextText += `[注意：因长度限制，已截断部分参考资料]\n`;
        break;
      }
      contextText += docContent;
      totalLength += docContent.length;
    }
  }

  // 获取 Agent 单例
  const { agent } = getOrCreateAgent(chatModel, tools);

  // 只传入用户问题到 messages，参考资料通过 context 传递
  const agentMessages = [{ role: 'user', content: query }];

  // 使用 streamEvents 获取逐 token 输出
  // ragContext 通过 configurable 传递，middleware 从 runtime.configurable 读取
  const stream = await agent.streamEvents(
    { messages: agentMessages },
    {
      configurable: {
        thread_id: threadId,
        ragContext: contextText,
      },
      version: 'v3',
    }
  );

  // 返回 AsyncIterator
  return stream;
}

// ========== 解耦版：流式对话 Generator =====
/**
 * 增强版 RAG 流式对话（解耦版）
 * 返回 AsyncGenerator，吐出标准化数据块，避免路由层依赖 LangChain 内部结构
 * @param {string} query - 用户问题
 * @param {string} threadId - 会话线程ID，用于隔离不同会话
 * @param {Array} contextDocs - 知识库检索结果 [{ text, docName }]
 * @param {Object} options - 配置选项 { model, temperature, maxContextTokens, tools }
 * @yields {Object} { type: 'text'|'tool_start'|'tool_result'|'error', content/tool/result/message, ... }
 */
async function* enhancedRagChatStreamGenerator(query, threadId, contextDocs = [], options = {}) {
  console.log('[Generator] 启动，query长度:', String(query || '').length);

  const { model = 'qwen-plus', temperature = 0.7, maxContextTokens = 2000, tools = [] } = options;

  try {
    const chatModel = createChatModel({ model, temperature, streaming: true });

    // ---- 构建 RAG 参考资料（保留原有截断逻辑） ----
    let contextText = '';
    if (contextDocs && contextDocs.length > 0) {
      contextText = '【参考资料】\n以下是从知识库检索到的相关信息，请参考这些内容回答问题：\n\n';
      let totalLength = contextText.length;
      for (const doc of contextDocs) {
        const docContent = `[来源：${doc.docName || '未知'}]\n${doc.text}\n\n`;
        if (totalLength + docContent.length > maxContextTokens) {
          contextText += `[注意：因长度限制，已截断部分参考资料]\n`;
          break;
        }
        contextText += docContent;
        totalLength += docContent.length;
      }
    }

    console.log('[Generator] 构建上下文完成，总长度:', contextText.length, '文档数:', contextDocs.length, 'maxContextTokens:', maxContextTokens);

    // ---- 获取 Agent 实例 ----
    const { agent } = getOrCreateAgent(chatModel, tools);

    console.log('[Generator] 开始调用 streamEvents...');

    // ---- 调用 Agent 流式事件（Node.js 版本返回 AgentRunStream）----
    const runStream = await agent.streamEvents(
      { messages: [{ role: 'user', content: query }] },
      {
        configurable: { thread_id: threadId, ragContext: contextText },
        version: 'v3',
      }
    );

    console.log('[Generator] streamEvents 返回，类型:', runStream.constructor?.name, '有messages:', !!runStream.messages);

    // ---- 遍历消息流，转换为标准格式（服务层说内部方言）----
    let messageCount = 0;
    for await (const msg of runStream.messages) {
      messageCount++;
      console.log('[Generator] 收到消息 #', messageCount, 'node:', msg.node);

      // 过滤掉中间件预处理阶段产生的流
      const node = msg.node || '';

      if (node.includes('before_model') || node.includes('middleware')) {
        console.log('[Generator] 跳过中间件流');
        continue;
      }

      // msg.text 是 AsyncIterator，逐 token 输出
      let tokenCount = 0;
      for await (const token of msg.text) {
        tokenCount++;
        console.log('[Generator] 产出 token #', tokenCount, '长度:', token.length);
        yield { type: 'text', content: token };
      }

      console.log('[Generator] 消息 #', messageCount, '产出', tokenCount, '个 token');
    }

    console.log('[Generator] 完成，共处理', messageCount, '条消息');

    // ---- 检查是否有 HITL 中断（桌面操作需用户确认）----
    try {
      const state = await agent.getState({ configurable: { thread_id: threadId } });
      const interrupts = state?.tasks?.[0]?.interrupts;
      if (interrupts && interrupts.length > 0) {
        console.log('[Generator] 检测到 HITL 中断，任务数:', state.tasks.length);
        const interruptData = interrupts[0].value;
        yield {
          type: 'interrupt',
          actionRequests: interruptData.actionRequests || [],
          reviewConfigs: interruptData.reviewConfigs || [],
          threadId: threadId,
        };
        return; // 中断状态下不继续
      }
    } catch (checkErr) {
      console.log('[Generator] 检查中断状态失败（非中断场景）:', checkErr.message);
    }

  } catch (error) {
    console.error('[Generator] 错误:', error.message);
    yield {
      type: 'error',
      message: error.message || '未知错误',
    };
  }
}

// ========== HITL 恢复流：用户确认后继续执行 ==========

/**
 * 恢复被 HITL 中断的流式对话
 * @param {string} threadId - 被中断的会话 thread_id
 * @param {Array} decisions - HITL 决策数组 [{ type: 'approve'|'reject', message?: string }]
 * @param {Object} options - { model, temperature, tools }
 * @yields {Object} 标准化数据块
 */
async function* resumeStreamGenerator(threadId, decisions, options = {}) {
  console.log('[Resume] 恢复会话:', threadId, 'decisions:', JSON.stringify(decisions));
  const { model = 'qwen-plus', temperature = 0.7, tools = [] } = options;

  try {
    const chatModel = createChatModel({ model, temperature, streaming: true });
    const { agent } = getOrCreateAgent(chatModel, tools);

    console.log('[Resume] 开始恢复 streamEvents...');

    const runStream = await agent.streamEvents(
      new Command({ resume: { decisions } }),
      {
        configurable: { thread_id: threadId },
        version: 'v3',
      }
    );

    console.log('[Resume] streamEvents 返回，类型:', runStream.constructor?.name);

    let messageCount = 0;
    for await (const msg of runStream.messages) {
      messageCount++;
      console.log('[Resume] 收到消息 #', messageCount, 'node:', msg.node);

      const node = msg.node || '';
      if (node.includes('before_model') || node.includes('middleware')) {
        console.log('[Resume] 跳过中间件流');
        continue;
      }

      let tokenCount = 0;
      for await (const token of msg.text) {
        tokenCount++;
        console.log('[Resume] 产出 token #', tokenCount, '长度:', token.length);
        yield { type: 'text', content: token };
      }

      console.log('[Resume] 消息 #', messageCount, '产出', tokenCount, '个 token');
    }

    console.log('[Resume] 完成，共处理', messageCount, '条消息');

    // 再次检查是否有新的中断
    try {
      const state = await agent.getState({ configurable: { thread_id: threadId } });
      const interrupts = state?.tasks?.[0]?.interrupts;
      if (interrupts && interrupts.length > 0) {
        const interruptData = interrupts[0].value;
        yield {
          type: 'interrupt',
          actionRequests: interruptData.actionRequests || [],
          reviewConfigs: interruptData.reviewConfigs || [],
          threadId: threadId,
        };
      }
    } catch (checkErr) {
      console.log('[Resume] 检查中断状态:', checkErr.message);
    }

  } catch (error) {
    console.error('[Resume] 错误:', error.message);
    yield {
      type: 'error',
      message: error.message || '未知错误',
    };
  }
}

// ========== Chain 示例：数据处理链 ==========
/**
 * 数据处理链示例：输入 -> 处理 -> 输出
 * 可用于构建复杂的多步骤处理流程
 */
async function processDataChain(input, options = {}) {
  const { model = 'qwen-plus' } = options;

  const chatModel = createChatModel({ model });

  // 定义处理步骤
  const analyzePrompt = PromptTemplate.fromTemplate(
    '分析以下内容，提取关键信息：\n{input}\n\n请列出关键点：'
  );

  const summarizePrompt = PromptTemplate.fromTemplate(
    '将以下关键点总结成简洁的一段话：\n{analysis}'
  );

  // 创建链
  const chain = RunnableSequence.from([
    {
      analysis: RunnableSequence.from([
        analyzePrompt,
        chatModel,
        new StringOutputParser()
      ])
    },
    RunnablePassthrough.assign({
      summary: RunnableSequence.from([
        summarizePrompt,
        chatModel,
        new StringOutputParser()
      ])
    })
  ]);

  const result = await chain.invoke({ input });

  return {
    analysis: result.analysis,
    summary: result.summary,
    model
  };
}

// ========== 推荐回答生成（无 checkpoint，手动上下文）==========
/**
 * 为客服工作台生成推荐回答
 *
 * 与 enhancedRagChatStreamGenerator 的区别：
 * - 不使用 Agent / Checkpointer，完全无状态
 * - 上下文由调用方手动传入（从 plat_messages 表查询）
 * - 可多次调用生成不同推荐，不污染会话持久化
 * - 推荐结果不会被保存到 checkpoint，只有客服实际发送的消息才会入库
 *
 * @param {string} query - 需要生成推荐的用户消息
 * @param {Array<{role: string, content: string}>} history - 手动传入的会话历史
 * @param {Array} contextDocs - 知识库检索结果 [{ text, docName }]
 * @param {Object} options - { model, temperature, maxContextTokens }
 * @yields {Object} { type: 'text'|'error', content|message }
 */
async function* generateRecommendationStream(query, history = [], contextDocs = [], options = {}) {
  console.log('[Recommendation] 启动，query长度:', String(query || '').length, '历史消息数:', history.length);

  const { model = 'qwen-plus', temperature = 0.7, maxContextTokens = 4000, customerLang = null, customerLangCode = null, customerLangLabel = null, systemPromptOverride = null, systemPromptAppend = null, langMode = null } = options;

  try {
    const chatModel = createChatModel({ model, temperature, streaming: true });

    // ---- 构建 RAG 参考资料文本 ----
    let contextText = '';
    if (contextDocs && contextDocs.length > 0) {
      contextText = '【参考资料】\n以下是从知识库检索到的相关信息，请参考这些内容回答用户问题：\n\n';
      let totalLength = contextText.length;
      for (const doc of contextDocs) {
        const docContent = `[来源：${doc.docName || '未知'}]\n${doc.text}\n\n`;
        if (totalLength + docContent.length > maxContextTokens) {
          contextText += `[注意：因长度限制，已截断部分参考资料]\n`;
          break;
        }
        contextText += docContent;
        totalLength += docContent.length;
      }
    }

    // ---- 构建系统提示词 ----
    // 如果调用方提供了 systemPromptOverride（如质检/情绪分析），直接使用自定义提示词
    // 否则使用配置中心的客服推荐提示词（prompts/ai_suggest_system_prompt.md）
    let systemPrompt
    if (systemPromptOverride) {
      systemPrompt = systemPromptOverride
    } else {
      const configService = require('../../services/configService');
      const baseSystemPrompt = await configService.getConfig('ai_suggest_system_prompt') ||
        `你是客服坐席的智能助手，负责根据用户消息和知识库资料生成推荐回复。`;

      // 语言模式：
      // - 'bilingual'（推荐回答场景）：非中文客户追加 ===CN=== 双语格式指令，生成原语言回复+中文翻译供坐席审核
      // - 'native_only'（AI 自助回复场景）：非中文客户只追加"用原语言回复"强化指令，不生成中文翻译
      // - 未设置时默认 'bilingual'（向后兼容推荐回答接口）
      const effectiveLangMode = langMode || 'bilingual';

      // 语言输出强约束：当前消息语言优先级高于历史消息、参考资料和基础提示词。
      // - 中文客户：只输出中文推荐，不要英文，不要 ===CN===。
      // - 非中文客户：推荐回答场景输出原语言 + ===CN=== + 中文翻译；AI自助场景只输出原语言。
      let langSuffix = '';
      if (customerLang === 'zh') {
        langSuffix = `\n\n【语言指令（最高优先级，必须遵守）】\n当前客户消息是中文。你必须只使用简体中文生成推荐回复。\n即使历史消息中客户或坐席曾使用英文、阿拉伯语或其他语言，也不能被历史语言带偏。\n不要输出英文回复，不要输出中文翻译区，不要输出 "===CN===" 分隔符，不要添加语言说明。`;
      } else if (customerLang === 'other') {
        const langName = customerLangLabel || customerLangCode || '客户消息的原语言';
        if (effectiveLangMode === 'bilingual') {
          langSuffix = `\n\n【双语格式指令（必须遵守）】\n当前客户消息不是中文。请使用客户的原语言（${langName}）撰写回复正文，不能被历史消息中的其他语言带偏。\n在原语言回复结束之后，必须另起一行、且仅输出 "===CN===" 作为分隔标记（前后各一个换行），然后在下一行输出该回复的中文翻译。中文翻译只翻译回复本身，不要添加任何解释或多余内容。\n格式示例：\n[原语言回复内容]\n===CN===\n[中文翻译内容]`;
        } else if (effectiveLangMode === 'native_only') {
          langSuffix = `\n\n【语言指令（最高优先级，必须遵守）】\n当前客户语言：${langName}。\n你必须只使用${langName}回复当前客户。\n即使历史消息、参考资料或系统基础提示词包含中文，也不能用中文回复非中文客户。\n如果客户发英文，最终回复必须是英文；客户发西班牙文，最终回复必须是西班牙文；以此类推。\n输出中不要包含中文翻译、语言说明、分隔符或额外注释。`;
        }
      }

      const outputSafetySuffix = `\n\n【客户输出安全指令（必须遵守）】\n历史消息中可能出现 "[AI回复]"、"[人工回复]" 等来源标记，这些只供你理解上下文来源。\n最终回复必须像真人客服直接发给客户的消息，禁止输出任何来源标记、系统标签、角色标签或解释性前缀。`;

      systemPrompt = `${baseSystemPrompt}\n\n${contextText}${langSuffix}${outputSafetySuffix}`;
      // systemPromptAppend：追加指令（不替换整个系统提示词），用于谨慎回答模式等场景
      if (systemPromptAppend) {
        systemPrompt += `\n\n${systemPromptAppend}`;
      }
    }

    // ---- 构建消息数组（System + History + Query）----
    const messages = [new SystemMessage(systemPrompt)];

    // 将历史消息转为 LangChain 消息对象
    // 对于 assistant 消息，不再把内部来源标签写入内容，避免模型复述到客户侧回复/推荐里。
    for (const msg of history) {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else if (msg.role === 'assistant') {
        const { sanitizeCustomerOutputText } = require('../../services/languageGuard');
        const content = sanitizeCustomerOutputText(msg.content);
        messages.push(new AIMessage(content));
      }
    }

    // 当前需要推荐的用户消息
    messages.push(new HumanMessage(query));

    console.log('[Recommendation] 消息数组构建完成，总消息数:', messages.length, '系统提示词长度:', systemPrompt.length, '客户语言:', customerLang || 'unknown', '语言模式:', langMode || 'bilingual');

    // ---- 流式输出 + 分隔符解析 ----
    // LLM 需要输出 "===CN===" 分隔符将原语言回复与中文翻译分开。
    // 但 LLM 输出不总是严格遵守格式，可能输出各种变体（--- cn ---、=== CN ===、--- 中文版本 --- 等）。
    // 这里用正则兼容多种变体，避免分隔符文本泄漏到正文。
    const stream = await chatModel.stream(messages);

    // 匹配各种分隔符变体的正则（大小写不敏感，允许两侧任意数量的 =、-、* 等符号和空格）
    // 命中组 1 = 分隔符之前的内容（原语言回复），命中组 2 = 分隔符之后的内容（中文翻译）
    const DELIM_REGEX = /(^|\n)\s*[-=*]{0,6}\s*(cn|中文(?:版本|翻译)?|chinese\s*version)\s*[-=*]{0,6}\s*(\n|$)/i;

    let tokenCount = 0;
    let fullRaw = '';       // 原始累积文本
    let textYieldedUpTo = 0; // 已 yield 的 text 部分长度
    let delimFound = false;

    for await (const chunk of stream) {
      const token = chunk.content;
      if (!token) continue;
      tokenCount++;
      fullRaw += token;

      if (!delimFound) {
        const m = DELIM_REGEX.exec(fullRaw);
        if (m) {
          // 找到分隔符 → yield 分隔符之前的未发送文本（即原语言回复）
          delimFound = true;
          const delimStart = m.index + (m[1] ? m[1].length : 0); // 跳过前导换行
          const newText = fullRaw.substring(textYieldedUpTo, delimStart);
          if (newText) yield { type: 'text', content: newText };
          textYieldedUpTo = delimStart;
        } else {
          // 未找到分隔符 → 保留末尾可能的部分匹配，避免分隔符被拆分到多个 chunk 时泄漏
          // 取当前累积文本末尾的一小段作为"待定"区，安全的部分先 yield
          const SAFE_TAIL = 20; // 分隔符最长不超过 20 字符，保留这么多字符不立即输出
          const safeEnd = Math.max(textYieldedUpTo, fullRaw.length - SAFE_TAIL);
          if (safeEnd > textYieldedUpTo) {
            yield { type: 'text', content: fullRaw.substring(textYieldedUpTo, safeEnd) };
            textYieldedUpTo = safeEnd;
          }
        }
      }
      // 分隔符之后的文本静默累积，最后统一 yield
    }

    if (!delimFound) {
      // 模型未输出任何分隔符变体 → 全部作为 text 输出
      if (textYieldedUpTo < fullRaw.length) {
        yield { type: 'text', content: fullRaw.substring(textYieldedUpTo) };
        textYieldedUpTo = fullRaw.length;
      }
    }

    // 提取中文版本
    let cnText = '';
    if (delimFound) {
      const m = DELIM_REGEX.exec(fullRaw);
      if (m) {
        cnText = fullRaw.substring(m.index + m[0].length).trim();
        // 确保原文完整输出（补发 SAFE_TAIL 保留区中属于原文的内容）
        const origEnd = m.index + (m[1] ? m[1].length : 0);
        if (textYieldedUpTo < origEnd) {
          yield { type: 'text', content: fullRaw.substring(textYieldedUpTo, origEnd) };
        }
      }
    }

    // 中文版本作为单个 chunk 输出（不流式，体量小）
    if (cnText) {
      yield { type: 'cn_version', content: cnText };
    }

    console.log('[Recommendation] 完成，token:', tokenCount, '双语:', delimFound, '中文长度:', cnText.length);

  } catch (error) {
    console.error('[Recommendation] 错误:', error.message);
    yield {
      type: 'error',
      message: error.message || '未知错误',
    };
  }
}

// ========== 导出模块 ==========
module.exports = {
  createChatModel,
  getOrCreateAgent,
  enhancedRagChatStream,  // 保留旧版（标记为 @deprecated）
  enhancedRagChatStreamGenerator,  // 新增解耦版
  resumeStreamGenerator,  // HITL 恢复流
  generateRecommendationStream,  // 推荐回答生成（无 checkpoint，手动上下文）
  processDataChain
};
