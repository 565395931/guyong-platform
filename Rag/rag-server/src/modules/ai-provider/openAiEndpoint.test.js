const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeOpenAiBaseUrl } = require('./openAiEndpoint')
const { createProviderRegistry } = require('./providerRegistry')
test('OpenAI endpoint accepts root, full completions and custom prefix', () => {
  assert.equal(normalizeOpenAiBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeOpenAiBaseUrl('https://aigw.telecomjs.com/v1/chat/completions'), 'https://aigw.telecomjs.com/v1')
  assert.equal(normalizeOpenAiBaseUrl('http://127.0.0.1:8790/v1'), 'http://127.0.0.1:8790/v1')
  assert.equal(normalizeOpenAiBaseUrl('https://example.test/custom/v1/models'), 'https://example.test/custom/v1')
  assert.throws(() => normalizeOpenAiBaseUrl('https://secret@example.test/v1'))
})
test('model discovery and connection probe use entered URL/key/model, not DashScope', async () => {
  const requests = [], provider = createProviderRegistry({ request: async req => { requests.push(req); return { data: { data: [{id:'model-a'}], choices: [{message:{content:'ok'}}] } } } }).get('openai-compatible')
  const args = { apiKey:'private-test-key', baseURL:'https://example.test/v1/chat/completions', model:'model-a' }
  assert.deepEqual(await provider.listModels(args), ['model-a'])
  assert.equal((await provider.testConnection(args)).protocol, 'openai-chat-completions')
  assert.equal(requests[0].url, 'https://example.test/v1/models'); assert.equal(requests[1].url, 'https://example.test/v1/chat/completions')
  assert.equal(requests[1].data.model, 'model-a')
})
