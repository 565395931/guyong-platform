const test = require('node:test')
const assert = require('node:assert/strict')

const { createCredentialCipher } = require('./credentialCipher')
const { maskCredential, normalizeDashScopeModels, createProviderRegistry } = require('./providerRegistry')

test('credential cipher round trips and rejects tampering', () => {
  const cipher = createCredentialCipher({ key: Buffer.alloc(32, 7).toString('base64') })
  const encrypted = cipher.encrypt('sk-secret-1234')
  assert.equal(cipher.decrypt(encrypted), 'sk-secret-1234')
  const parts = encrypted.split('.')
  parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`
  assert.throws(() => cipher.decrypt(parts.join('.')), /decrypt/i)
})

test('credential metadata never exposes the secret', () => {
  assert.deepEqual(maskCredential('sk-secret-1234', 'database'), {
    configured: true, source: 'database', lastFour: '1234'
  })
  assert.equal(JSON.stringify(maskCredential('sk-secret-1234', 'database')).includes('secret'), false)
})

test('DashScope model responses become sorted unique model ids', () => {
  assert.deepEqual(normalizeDashScopeModels({ output: { models: [
    { model_name: 'qwen-plus' }, { name: 'deepseek-v4-flash' }, { model_name: 'qwen-plus' }
  ] } }), ['deepseek-v4-flash', 'qwen-plus'])
})

test('DashScope declares balance unsupported', async () => {
  const registry = createProviderRegistry({ request: async () => ({ data: {} }) })
  assert.deepEqual(await registry.get('dashscope').getBalance({ apiKey: 'x' }), {
    supported: false,
    reason: 'DashScope does not expose an API-key balance endpoint'
  })
})
