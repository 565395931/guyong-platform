const test = require('node:test')
const assert = require('node:assert/strict')

const { getPublicAiConfigKeys, validatePublicAiConfig } = require('../../services/aiConfigValidation')
const { createBailianCredentialService } = require('./bailianCredentialService')

// ========== 新增的可配置项 ==========

test('exposes the interface and Bailian app keys as editable', () => {
  const keys = getPublicAiConfigKeys()
  for (const key of [
    'ai_chat_base_url', 'ai_chat_model', 'ai_suggestion_enabled',
    'bailian_workspace_id', 'bailian_index_id', 'bailian_category_id'
  ]) {
    assert.ok(keys.includes(key), `${key} 应该在可配置键里`)
  }
})

test('interface and Bailian ids accept being cleared (fall back to .env)', () => {
  assert.equal(validatePublicAiConfig('ai_chat_base_url', ''), '')
  assert.equal(validatePublicAiConfig('bailian_index_id', ''), '')
  assert.equal(validatePublicAiConfig('ai_chat_base_url', '  https://x/v1  '), 'https://x/v1')
})

test('the suggestion switch stays a strict boolean', () => {
  assert.equal(validatePublicAiConfig('ai_suggestion_enabled', true), true)
  assert.throws(() => validatePublicAiConfig('ai_suggestion_enabled', 'true'), /must be a boolean/)
})

// ========== 百炼凭据：密文保存 + 只回掩码 ==========

// 32 字节 base64，供测试用（不是真实凭据）
const TEST_KEY = Buffer.alloc(32, 7).toString('base64')

function createStubStore() {
  const store = new Map()
  return {
    store,
    getConfig: async key => store.get(key) ?? null,
    updateConfig: async (key, value) => { store.set(key, value); return { success: true } }
  }
}

function createService(env = {}) {
  const { store, getConfig, updateConfig } = createStubStore()
  const { createCredentialCipher } = require('./credentialCipher')
  const service = createBailianCredentialService({
    getConfig,
    updateConfig,
    cipher: createCredentialCipher({ key: TEST_KEY }),
    env
  })
  return { service, store }
}

test('saving Bailian keys stores ciphertext, never the plaintext', async () => {
  const { service, store } = createService()
  await service.saveCredential({ accessKeyId: 'LTAI-test-id', accessKeySecret: 'super-secret-value' })

  const raw = store.get('bailian_credential_ciphertext')
  assert.ok(raw, '应该写入了密文')
  assert.match(raw, /^v1\./)
  assert.ok(!raw.includes('super-secret-value'), '密文里不能出现明文')
  assert.ok(!raw.includes('LTAI-test-id'), 'AccessKeyId 也不能明文存')
})

test('Bailian status only returns masks', async () => {
  const { service } = createService()
  await service.saveCredential({ accessKeyId: 'LTAI-test-id', accessKeySecret: 'super-secret-value' })

  const status = await service.getStatus()
  assert.equal(status.credential.configured, true)
  assert.equal(status.credential.source, 'database')
  assert.ok(!status.credential.accessKeyIdMasked.includes('test-id'))
  assert.ok(!JSON.stringify(status).includes('super-secret-value'))
})

test('Bailian credential falls back to environment, then to none', async () => {
  const empty = createService({})
  assert.equal((await empty.service.getCredential()).source, 'none')

  const withEnv = createService({
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'LTAI-env',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'env-secret'
  })
  const credential = await withEnv.service.getCredential()
  assert.equal(credential.source, 'environment')
  assert.equal(credential.accessKeyId, 'LTAI-env')
})

test('clearing the Bailian override goes back to the environment', async () => {
  const env = { ALIBABA_CLOUD_ACCESS_KEY_ID: 'LTAI-env', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'env-secret' }
  const { service, store } = createService(env)
  await service.saveCredential({ accessKeyId: 'LTAI-db', accessKeySecret: 'db-secret' })
  assert.equal((await service.getCredential()).accessKeyId, 'LTAI-db')

  await service.clearCredential()
  assert.equal(store.get('bailian_credential_ciphertext'), null)
  const after = await service.getCredential()
  assert.equal(after.source, 'environment')
  assert.equal(after.accessKeyId, 'LTAI-env')
})

test('saving Bailian keys requires both halves', async () => {
  const { service } = createService()
  await assert.rejects(
    () => service.saveCredential({ accessKeyId: 'only-id' }),
    /都要填/
  )
})
