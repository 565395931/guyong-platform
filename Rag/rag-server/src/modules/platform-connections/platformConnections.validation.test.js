const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeConnectionInput,
  normalizeAccountPolicy,
  normalizeAllowlistInput,
  normalizeOperationLogQuery
} = require('./platformConnections.validation')

test('normalizes a WeCom enterprise connection', () => {
  assert.deepEqual(normalizeConnectionInput({
    connectionName: ' 孤勇者企业微信 ',
    corpId: ' ww123 ',
    secret: ' secret ',
    callbackToken: ' token ',
    encodingAesKey: ' aes-key '
  }), {
    connection_name: '孤勇者企业微信',
    channel_code: 'wecom_kf',
    corp_id: 'ww123',
    secret: 'secret',
    callback_token: 'token',
    encoding_aes_key: 'aes-key'
  })
})

test('requires credentials when creating a connection', () => {
  assert.throws(() => normalizeConnectionInput({
    connectionName: '测试企业', corpId: 'ww123'
  }), /secret is required/)
})

test('allows metadata-only normalization for existing connections', () => {
  assert.deepEqual(normalizeConnectionInput({
    connectionName: '测试企业', corpId: 'ww123'
  }, { requireCredentials: false }), {
    connection_name: '测试企业',
    channel_code: 'wecom_kf',
    corp_id: 'ww123'
  })
})

test('normalizes a test account policy', () => {
  assert.deepEqual(normalizeAccountPolicy({
    protectionLevel: 'TEST', aiEnabled: true, allowlistEnabled: true
  }), {
    protection_level: 'test',
    ai_enabled: true,
    allowlist_enabled: true
  })
})

test('rejects AI for locked or non-allowlisted test accounts', () => {
  assert.throws(() => normalizeAccountPolicy({
    protectionLevel: 'locked', aiEnabled: true, allowlistEnabled: true
  }), /locked account cannot enable AI/)
  assert.throws(() => normalizeAccountPolicy({
    protectionLevel: 'test', aiEnabled: true, allowlistEnabled: false
  }), /test account requires allowlist/)
})

test('normalizes an allowlist entry and rejects oversized identifiers', () => {
  assert.deepEqual(normalizeAllowlistInput({
    externalUserId: ' wm_test_user ', label: ' 内部测试手机 '
  }), {
    external_user_id: 'wm_test_user',
    label: '内部测试手机'
  })
  assert.throws(
    () => normalizeAllowlistInput({ externalUserId: 'x'.repeat(161) }),
    /externalUserId is too long/
  )
})

test('normalizes bounded operation log filters', () => {
  assert.deepEqual(normalizeOperationLogQuery({
    connectionId: '8', accountId: '12', action: ' allowlist_added ', page: '2', pageSize: '500'
  }), {
    connection_id: 8,
    account_id: 12,
    action: 'allowlist_added',
    page: 2,
    page_size: 100,
    offset: 100
  })
  assert.throws(() => normalizeOperationLogQuery({ accountId: 'bad' }), /accountId is invalid/)
})
