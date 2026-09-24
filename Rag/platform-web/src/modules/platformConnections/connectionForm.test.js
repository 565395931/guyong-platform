import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeConnectionForm,
  validateConnectionForm,
  normalizeCredentialReplacementForm,
  validateCredentialReplacementForm,
  canPublishRuntime,
  canDisableRuntime,
  canEditAccountConfiguration,
  canOpenAllowlist,
  normalizeAllowlistForm,
  validateAllowlistForm,
  normalizeOperationLogFilters,
  normalizePolicyForm,
  validatePolicyForm
} from './connectionForm.js'

test('normalizes enterprise connection credentials', () => {
  assert.deepEqual(normalizeConnectionForm({
    connectionName: ' 孤勇者企业微信 ', corpId: ' ww123 ', secret: ' secret ',
    callbackToken: ' token ', encodingAesKey: ' aes-key '
  }), {
    connectionName: '孤勇者企业微信',
    corpId: 'ww123',
    secret: 'secret',
    callbackToken: 'token',
    encodingAesKey: 'aes-key'
  })
})

test('validates all connection fields', () => {
  assert.deepEqual(validateConnectionForm({}), [
    '企业连接名称不能为空',
    'CorpID 不能为空',
    '微信客服 Secret 不能为空',
    '回调 Token 不能为空',
    'EncodingAESKey 不能为空'
  ])
})

test('does not submit masked credential placeholders', () => {
  const normalized = normalizeConnectionForm({
    connectionName: '测试', corpId: 'ww123', secret: '******',
    callbackToken: '******', encodingAesKey: '******'
  })
  assert.equal(normalized.secret, '')
  assert.equal(normalized.callbackToken, '')
  assert.equal(normalized.encodingAesKey, '')
})

test('credential replacement submits only fresh secret fields', () => {
  const normalized = normalizeCredentialReplacementForm({
    connectionName: '[ignored]',
    corpId: 'wx_masked',
    secret: ' new-secret ',
    callbackToken: ' new-token ',
    encodingAesKey: ' new-aes-key '
  })

  assert.deepEqual(normalized, {
    secret: 'new-secret',
    callbackToken: 'new-token',
    encodingAesKey: 'new-aes-key'
  })
  assert.deepEqual(validateCredentialReplacementForm({}), [
    '微信客服 Secret 不能为空',
    '回调 Token 不能为空',
    'EncodingAESKey 不能为空'
  ])
})

test('normalizes and validates safe account policies', () => {
  const policy = normalizePolicyForm({
    protectionLevel: 'TEST', aiEnabled: true, allowlistEnabled: true
  })
  assert.deepEqual(policy, {
    protectionLevel: 'test', aiEnabled: true, allowlistEnabled: true
  })
  assert.deepEqual(validatePolicyForm(policy), [])
  assert.deepEqual(validatePolicyForm({
    protectionLevel: 'locked', aiEnabled: true, allowlistEnabled: true
  }), ['生产保护账号不能启用 AI'])
})

test('publishes runtime only for verified connections with synced accounts', () => {
  assert.equal(canPublishRuntime({ status: 'verified', accountCount: 2 }), true)
  assert.equal(canPublishRuntime({ status: 'active', accountCount: 2 }), true)
  assert.equal(canPublishRuntime({ status: 'draft', accountCount: 2 }), false)
  assert.equal(canPublishRuntime({ status: 'verified', accountCount: 0 }), false)
})

test('requires an explicit gateway stop before editing active account configuration', () => {
  assert.equal(canDisableRuntime({ status: 'active' }), true)
  assert.equal(canDisableRuntime({ status: 'verified' }), false)
  assert.equal(canEditAccountConfiguration({ status: 'active' }), false)
  assert.equal(canEditAccountConfiguration({ status: 'disabled' }), true)
})

test('opens allowlist management only for non-baseline test accounts', () => {
  assert.equal(canOpenAllowlist({ protectionLevel: 'test', lockedReason: null }), true)
  assert.equal(canOpenAllowlist({ protectionLevel: 'locked', lockedReason: null }), false)
  assert.equal(canOpenAllowlist({
    protectionLevel: 'test', lockedReason: 'production_baseline'
  }), false)
})

test('normalizes and validates allowlist entries', () => {
  assert.deepEqual(normalizeAllowlistForm({
    externalUserId: ' wm_test ', label: ' 内部测试手机 '
  }), { externalUserId: 'wm_test', label: '内部测试手机' })
  assert.deepEqual(validateAllowlistForm({}), ['外部联系人 ID 不能为空'])
  assert.deepEqual(validateAllowlistForm({ externalUserId: 'x'.repeat(161) }), ['外部联系人 ID 不能超过 160 个字符'])
})

test('builds compact operation-log query parameters', () => {
  assert.deepEqual(normalizeOperationLogFilters({
    connectionId: '8', accountId: '', action: 'allowlist_added', page: 2, pageSize: 20
  }), { connectionId: 8, action: 'allowlist_added', page: 2, pageSize: 20 })
})
