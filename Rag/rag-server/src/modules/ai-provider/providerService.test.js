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
