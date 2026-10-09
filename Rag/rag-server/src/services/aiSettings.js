const configService = require('./configService')
const { getBailianCredentialService } = require('../modules/ai-provider/bailianCredentialService')

/**
 * AI 运行期设置的**统一取值口**。
 *
 * 为什么需要它：这些值原先散落在各处按 `process.env.XXX` 读，而且多数是**模块级常量**
 * （加载时读死）——在配置页改了以后不重启不生效，只能改 .env 再重启。这里改成
 * **每次调用现取**：数据库配置优先，其次 .env，最后内置默认值。
 *
 * configService 自己带 Redis 缓存 + 配置变更广播，所以这里直接用 getConfig，不再加一层缓存。
 */

const DEFAULT_CHAT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_CHAT_MODEL = 'qwen-plus'

async function readConfig(key) {
  try {
    return await configService.getConfig(key)
  } catch (err) {
    console.error(`[AiSettings] 读取配置 ${key} 失败，回退环境变量:`, err.message)
    return null
  }
}

/** 大模型（OpenAI 兼容）接口地址；配置页留空则回退 .env / 内置默认。 */
async function getChatBaseUrl() {
  const configured = await readConfig('ai_chat_base_url')
  return (configured && String(configured).trim())
    || process.env.DASHSCOPE_BASE_URL
    || DEFAULT_CHAT_BASE_URL
}

/** 通用默认模型：各处 "没指定模型时用哪个" 都取它。 */
async function getChatModel() {
  const configured = await readConfig('ai_chat_model')
  return (configured && String(configured).trim())
    || process.env.DASHSCOPE_MODEL
    || DEFAULT_CHAT_MODEL
}

/** AI 推荐回答开关（原 AI_SUGGESTION_ENABLED，默认关）。 */
async function isAiSuggestionEnabled() {
  const configured = await readConfig('ai_suggestion_enabled')
  if (configured !== null && configured !== undefined && configured !== '') return Boolean(configured)
  return String(process.env.AI_SUGGESTION_ENABLED || '').toLowerCase() === 'true'
}

/** 百炼应用标识 + 凭据（知识库上传/解析用）。 */
async function getBailianSettings() {
  const [workspaceId, indexId, categoryId] = await Promise.all([
    readConfig('bailian_workspace_id'),
    readConfig('bailian_index_id'),
    readConfig('bailian_category_id')
  ])
  const service = getBailianCredentialService()
  const credential = service
    ? await service.getCredential()
    : {
      accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
      accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '',
      source: 'environment'
    }
  return {
    workspaceId: (workspaceId && String(workspaceId).trim()) || process.env.WORKSPACE_ID || '',
    indexId: (indexId && String(indexId).trim()) || process.env.INDEX_ID || '',
    categoryId: (categoryId && String(categoryId).trim()) || process.env.CATEGORY_ID || '',
    accessKeyId: credential.accessKeyId || '',
    accessKeySecret: credential.accessKeySecret || '',
    credentialSource: credential.source || 'none'
  }
}

/** 一次性取全（一次请求里要用多个值时用，避免多次 await）。 */
async function getAiRuntimeSettings() {
  const [chatBaseUrl, chatModel, suggestionEnabled, bailian] = await Promise.all([
    getChatBaseUrl(), getChatModel(), isAiSuggestionEnabled(), getBailianSettings()
  ])
  return { chatBaseUrl, chatModel, suggestionEnabled, bailian }
}

module.exports = {
  getChatBaseUrl,
  getChatModel,
  isAiSuggestionEnabled,
  getBailianSettings,
  getAiRuntimeSettings,
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_CHAT_MODEL
}
