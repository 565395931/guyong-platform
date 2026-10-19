const test = require('node:test')
const assert = require('node:assert/strict')

const { createProviderService } = require('./providerService')

function fixture({ stored = null, env = 'env-key-9999' } = {}) {
  let value = stored
  const provider = {
    id: 'dashscope', label: 'DashScope', baseURL: 'https://example.test/v1',
    capabilities: { models: true, balance: false },
    listModels: async () => ['qwen-plus'], testConnection: async ({ apiKey }) => ({ ok: apiKey.length > 0 }),
    getBalance: async () => ({ supported: false, reason: 'unsupported' })
  }
  return createProviderService({
    getConfig: async key => key === 'ai_provider_credential_ciphertext' ? value : null,
    updateConfig: async (_key, next) => { value = next; return { success: true } },
    cipher: { encrypt: secret => `encrypted:${secret}`, decrypt: encrypted => encrypted.slice(10) },
    registry: { get: () => provider, list: () => [provider] }, env: { DASHSCOPE_API_KEY: env }
  })
}

test('status exposes environment fallback without the credential', async () => {
  const status = await fixture().getStatus()
  assert.equal(status.credential.source, 'environment')
  assert.equal(status.credential.lastFour, '9999')
  assert.equal(JSON.stringify(status).includes('env-key'), false)
})

test('saving and clearing encrypted override changes credential source', async () => {
  const service = fixture()
  await service.saveCredential('database-key-1234', 1)
  assert.equal((await service.getStatus()).credential.source, 'database')
  await service.clearCredential(1)
  assert.equal((await service.getStatus()).credential.source, 'environment')
})

test('failed model sync preserves the previous successful models', async () => {
  const service = fixture()
  assert.deepEqual((await service.syncModels()).models, ['qwen-plus'])
  service._provider.listModels = async () => { throw new Error('down') }
  await assert.rejects(service.syncModels, /down/)
  assert.deepEqual((await service.getStatus()).models, ['qwen-plus'])
})

test('atomic connection retains prompt/context and reset survives environment fallback',async()=>{const values={};const service=createProviderService({getConfig:async key=>values[key],updateConfig:async(key,value)=>{values[key]=value;return {success:true}},cipher:{encrypt:s=>'encrypted:'+s,decrypt:s=>s.slice(10)},env:{DASHSCOPE_API_KEY:'old-environment-key'}});await service.saveConnection({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',apiKey:'new-test-key-1234',contextMessageCount:7,systemPrompt:'custom'});assert.deepEqual(await service.getReplySettings(),{contextMessageCount:7,systemPrompt:'custom'});assert.ok(!JSON.stringify(await service.getStatus()).includes('new-test-key'));await assert.rejects(service.saveConnection({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',contextMessageCount:-1}),/上下文/);await service.resetConnection();assert.equal((await service.getStatus()).credential.configured,false);assert.equal((await service.getStatus()).provider.baseURL,'');await assert.rejects(service.getRuntimeConfig(),/not configured/)});

test('model switch blocks runtime without deleting credentials or reply settings',async()=>{const values={};const service=createProviderService({getConfig:async k=>values[k],updateConfig:async(k,v)=>{values[k]=v;return {success:true}},cipher:{encrypt:s=>'sealed:'+s,decrypt:s=>s.slice(7)},env:{}});await service.saveConnection({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',apiKey:'unit-secret-key',systemPrompt:'业务规则',contextMessageCount:9});await service.setEnabled(false);await assert.rejects(service.getRuntimeConfig(),/已关闭/);assert.equal((await service.getStatus()).credential.configured,true);await service.setEnabled(true);assert.equal((await service.getRuntimeConfig()).systemPrompt,'业务规则');await assert.rejects(service.setEnabled('false'),/布尔值/)})

test('editable default template persists into status and runtime; invalid saves keep prior template',async()=>{const values={};const service=createProviderService({getConfig:async k=>values[k],updateConfig:async(k,v)=>{values[k]=v;return {success:true}},cipher:{encrypt:s=>'sealed:'+s,decrypt:s=>s.slice(7)},env:{}});await service.saveConnection({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',apiKey:'test-secret-key'});const original=(await service.getStatus()).defaultPromptTemplate;await service.saveDefaultPromptTemplate(original+'\n新增测试规则');assert.match((await service.getRuntimeConfig()).defaultPromptTemplate,/新增测试规则/);await assert.rejects(service.saveDefaultPromptTemplate(''),/模板/);assert.match((await service.getDefaultPromptTemplate()),/新增测试规则/);await service.saveDefaultPromptTemplate((await service.getStatus()).builtinDefaultPromptTemplate);assert.equal(await service.getDefaultPromptTemplate(),original)})

test('channel prompts start empty, isolate channels, persist blanks and reject invalid saves',async()=>{const values={};const service=createProviderService({getConfig:async k=>values[k],updateConfig:async(k,v)=>{values[k]=v;return {success:true}},cipher:{encrypt:s=>'sealed:'+s,decrypt:s=>s.slice(7)},env:{}});assert.deepEqual(await service.getChannelPrompts(),{});assert.equal(await service.getChannelPrompt('wechat_shop'),'');await service.saveConnection({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',apiKey:'test-secret-key'});await service.saveChannelPrompts({wechat_shop:'小店规则',whatsapp:''});assert.equal(await service.getChannelPrompt('wechat_shop'),'小店规则');assert.equal(await service.getChannelPrompt('whatsapp'),'');assert.equal((await service.getRuntimeConfig()).channelPrompts.wechat_shop,'小店规则');await assert.rejects(service.saveChannelPrompts({wechat_shop:'x'.repeat(20001)}),/最长/);assert.equal(await service.getChannelPrompt('wechat_shop'),'小店规则');await service.saveChannelPrompts({wechat_shop:''});assert.equal(await service.getChannelPrompt('wechat_shop'),'');await assert.rejects(service.saveChannelPrompts({constructor:'bad'}),/标识/)});
