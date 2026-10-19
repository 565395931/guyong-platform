const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FileSaasStore } = require('../src/saas/fileSaasStore')
const CloudMessagingService = require('../src/saas/cloudMessagingService')
const { createSecretCipher } = require('../src/saas/secretCipher')
const { createOpenAiCompatibleClient } = require('../src/saas/openAiCompatibleClient')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-messaging-'))
  const store = new FileSaasStore(path.join(directory, 'store.json'))
  const calls = []
  const modelClient = createOpenAiCompatibleClient({
    allowInsecure: true,
    transport: async input => {
      calls.push(input)
      return { model: input.body.model, choices: [{ message: { content: '您好，这是 AI 建议。' } }], usage: { total_tokens: 9 } }
    }
  })
  const sends = []
  const mediaReads = []
  const service = new CloudMessagingService({
    store,
    cipher: createSecretCipher(Buffer.alloc(32, 7).toString('base64')),
    modelClient,
    wecomSender: {
      async sendText(input) { sends.push(input); return { channelMessageId: 'wecom-out-1' } },
      async downloadMedia(input) { mediaReads.push(input); return { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), contentType: 'application/octet-stream' } }
    },
    now: (() => { let value = 0; return () => `2026-09-29T10:00:0${value++}.000Z` })()
  })
  return { directory, store, service, calls, sends, mediaReads }
}

test('new model configuration defaults to DeepSeek Flash customer-service settings', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  const config = await f.service.getModelConfig()
  assert.deepEqual({
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens
  }, {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    temperature: 0.8,
    maxTokens: 2000
  })
})

test('model config encrypts the API key and exposes only a preview', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  const saved = await f.service.saveModelConfig({ baseUrl: 'http://models.example.test/v1', apiKey: 'sk-secret-123456', model: 'deepseek-chat', temperature: 0.3, maxTokens: 600, systemPrompt: '专业回复' }, 'admin-1')
  assert.equal(saved.configured, true)
  assert.equal(saved.apiKeyPreview.includes('secret'), false)
  const snapshot = await f.store.snapshot()
  assert.equal(JSON.stringify(snapshot).includes('sk-secret-123456'), false)
  const result = await f.service.testModel({}, 'admin-1')
  assert.equal(result.ok, true)
  assert.equal(f.calls[0].apiKey, 'sk-secret-123456')
})

test('inbound messages deduplicate, generate a draft and send only after confirmation', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  await f.store.transaction(data => {
    data.tenants.push({ id: 'tenant-1', name: '测试企业', slug: 'demo' })
    data.wecomInstallations.push({ id: 'install-1', tenantId: 'tenant-1', corpId: 'wwDemo123' })
  })
  await f.service.saveModelConfig({ baseUrl: 'http://models.example.test/v1', apiKey: 'sk-secret', model: 'qwen-plus' }, 'admin-1')
  const inbound = { corpId: 'wwDemo123', openKfId: 'wk-1', externalUserId: 'customer-1', channelMessageId: 'msg-1', text: '请问几点营业？', customerName: '张先生' }
  await f.service.ingestInbound(inbound)
  await f.service.ingestInbound(inbound)
  let inbox = await f.service.inbox()
  assert.equal(inbox.messages.length, 1)
  const draft = await f.service.generateDraft(inbox.selected.id, 'admin-1')
  assert.equal(draft.status, 'draft')
  assert.equal(f.sends.length, 0)
  const sent = await f.service.sendReply(inbox.selected.id, draft.text, 'admin-1')
  assert.equal(sent.status, 'sent')
  assert.equal(f.sends.length, 1)
  inbox = await f.service.inbox(inbox.selected.id)
  assert.equal(inbox.messages.length, 3)
})

test('model base URL rejects private network targets', () => {
  const client = createOpenAiCompatibleClient()
  assert.throws(() => client.normalizeBaseUrl('http://127.0.0.1:11434/v1'), /HTTPS|本机|内网/)
  assert.throws(() => client.normalizeBaseUrl('https://192.168.1.8/v1'), /本机|内网/)
})

test('official DeepSeek chat requests disable thinking for fast customer-service text', async () => {
  let request
  const client = createOpenAiCompatibleClient({
    transport: async input => {
      request = input
      return { model: input.body.model, choices: [{ message: { content: '连接成功' } }] }
    }
  })

  await client.complete({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    model: 'deepseek-flash',
    maxTokens: 128
  }, { messages: [{ role: 'user', content: '测试' }] })

  assert.deepEqual(request.body.thinking, { type: 'disabled' })
  assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions')
})

test('image media id stays encrypted and the authenticated media flow returns a verified image', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  await f.store.transaction(data => {
    data.tenants.push({ id: 'tenant-1', name: '测试企业', slug: 'demo' })
    data.wecomInstallations.push({ id: 'install-1', tenantId: 'tenant-1', corpId: 'wwDemo123' })
  })
  const created = await f.service.ingestInbound({ corpId: 'wwDemo123', openKfId: 'wk-1', externalUserId: 'customer-1', channelMessageId: 'image-1', messageType: 'image', mediaId: 'sensitive-media-id', text: '[图片消息]' })
  const snapshot = await f.store.snapshot()
  assert.equal(JSON.stringify(snapshot).includes('sensitive-media-id'), false)
  assert.ok(snapshot.messages[0].mediaIdEncrypted)
  const inbox = await f.service.inbox()
  assert.equal(inbox.messages[0].mediaIdEncrypted, undefined)
  assert.equal(inbox.messages[0].mediaUrl, `/v1/admin/messages/${created.id}/media`)
  const image = await f.service.image(created.id)
  assert.equal(image.contentType, 'image/png')
  assert.equal(f.mediaReads[0].mediaId, 'sensitive-media-id')
})

test('AI draft receives the complete real conversation including available images and excludes old drafts', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  await f.store.transaction(data => {
    data.tenants.push({ id: 'tenant-1', name: '测试企业', slug: 'demo' })
    data.wecomInstallations.push({ id: 'install-1', tenantId: 'tenant-1', corpId: 'wwDemo123' })
  })
  await f.service.saveModelConfig({ baseUrl: 'http://models.example.test/v1', apiKey: 'sk-secret', model: 'deepseek-flash' }, 'admin-1')
  await f.service.ingestInbound({ corpId: 'wwDemo123', openKfId: 'wk-1', externalUserId: 'customer-1', channelMessageId: 'text-1', text: '第一条消息' })
  const image = await f.service.ingestInbound({ corpId: 'wwDemo123', openKfId: 'wk-1', externalUserId: 'customer-1', channelMessageId: 'image-1', messageType: 'image', mediaId: 'media-for-ai', text: '[图片消息]' })
  const inbox = await f.service.inbox()
  await f.store.transaction(data => {
    data.messages.push({ id: 'sent-1', conversationId: inbox.selected.id, tenantId: 'tenant-1', direction: 'outbound', sender: 'operator', text: '人工已经回复', status: 'sent', createdAt: '2026-09-29T10:00:08.000Z' })
    data.messages.push({ id: 'draft-old', conversationId: inbox.selected.id, tenantId: 'tenant-1', direction: 'draft', sender: 'ai', text: '不应再次发给模型的旧草稿', status: 'draft', createdAt: '2026-09-29T10:00:09.000Z' })
  })

  await f.service.generateDraft(inbox.selected.id, 'admin-1')

  const messages = f.calls.at(-1).body.messages
  assert.equal(messages.length, 4)
  assert.equal(messages[1].content, '第一条消息')
  assert.equal(messages[2].role, 'user')
  assert.equal(messages[2].content[0].type, 'text')
  assert.equal(messages[2].content[1].type, 'image_url')
  assert.match(messages[2].content[1].image_url.url, /^data:image\/png;base64,/)
  assert.equal(messages[3].content, '人工已经回复')
  assert.equal(JSON.stringify(messages).includes('旧草稿'), false)
  assert.equal(f.mediaReads.at(-1).mediaId, 'media-for-ai')
  assert.equal(image.messageType, 'image')
})
