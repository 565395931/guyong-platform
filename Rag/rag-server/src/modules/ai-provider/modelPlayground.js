function buildMessages(input, settings) {
  const message = String(input.message || '').trim()
  if ((!message && !input.image) || message.length > 20000) throw new Error('请输入测试消息（最长20000字）')
  if (input.image && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.image) || input.image.length > 470000)) throw new Error('请选择350KB以内的PNG、JPEG或WebP图片')
  const content = input.image ? [{type:'text',text:message || '请描述这张图片'},{type:'image_url',image_url:{url:input.image}}] : message
  return require('./replyContext').assembleReplyMessages({businessPrompt:settings.systemPrompt || '',extraInstructions:Object.hasOwn(settings.channelPrompts || {},input.channel || '') ? settings.channelPrompts[input.channel] : '',defaultTemplate:settings.defaultPromptTemplate,history:input.history,contextMessageCount:settings.contextMessageCount,currentContent:content,contextDocs:settings.contextDocs || []})
}
function selectTestModel(input, config, models) {
  const model = input.model === undefined ? config.model : String(input.model).trim()
  if (!model || ![config.model, ...models].includes(model)) throw new Error('请选择已配置服务中的模型，或先刷新模型列表')
  return model
}
async function runPlayground(input, dependencies = {}) {
  const service = dependencies.service || require('./providerService').getProviderService()
  const config = await service.getRuntimeConfig()
  const status = await service.getStatus()
  const model = selectTestModel(input, config, status.models || [])
  const systemPrompt = config.systemPrompt || ''
  let prepared = buildMessages(input, config)
  const protocol = require('./replyProtocol')
  if (protocol.explicitHumanRequest(input.message)) return { ...protocol.customerHandoff(), content:protocol.customerHandoff().reply,model,contextCount:prepared.contextCount,systemPromptApplied:true,userMessage:prepared.userMessage,elapsedMs:0,localDecision:true }
  let retrieval = null
  if (input.useBailian === true) {
    retrieval = await (dependencies.retrieve || (query => require('./bailianSearchService').getBailianSearchService().search(query)))(require('./replyContext').buildKnowledgeQuery(input.message || '请描述图片相关知识'))
    prepared = buildMessages(input, {...config,contextDocs:retrieval.nodes})
  }
  if (Buffer.byteLength(JSON.stringify(prepared.messages)) > 500000) throw new Error('测试上下文过长，请清空记录后重试')
  const options = await (dependencies.runtimeOptions || require('./modelRuntime').runtimeOptions)(model)
  const OpenAI = dependencies.OpenAI || require('openai')
  const client = new OpenAI({ apiKey:config.apiKey,baseURL:config.baseURL,maxRetries:0,fetch:options.configuration.fetch,timeout:60000 })
  const start = Date.now()
  const response = await client.chat.completions.create({model,messages:prepared.messages,max_tokens:2048,stream:false})
  const content = response.choices?.[0]?.message?.content
  if (!content?.trim()) throw new Error('模型未返回文本，请检查配置')
  const decision = protocol.parseReplyDecision(content)
  return { ...decision,retrieval:retrieval ? {nodes:retrieval.nodes.slice(0,5),elapsedMs:retrieval.elapsedMs} : null,content:decision.reply,model:response.model || model,usage:response.usage,billing:response.billing,elapsedMs:Date.now()-start,contextCount:prepared.contextCount,systemPromptApplied:true,businessPromptApplied:Boolean(systemPrompt),userMessage:prepared.userMessage }
}
module.exports = { buildMessages, selectTestModel, runPlayground }
