'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildRuntimeConfig, normalizeServerUrl } = require('./runtime-config.cjs')

test('normalizes a valid center server origin', () => {
  assert.equal(normalizeServerUrl('https://example.test///'), 'https://example.test')
})

test('rejects credentials and paths in the center server URL', () => {
  assert.throws(() => normalizeServerUrl('https://user:pass@example.test'), /不能包含账号或密码/)
  assert.throws(() => normalizeServerUrl('https://example.test/api'), /不能包含路径/)
})

test('uses the Vite proxy only in development', () => {
  assert.deepEqual(buildRuntimeConfig('', { isDevelopment: true }), {
    serverUrl: '', apiBaseUrl: '/api', wsUrl: '', mode: 'vite-proxy'
  })
})

test('builds absolute API and websocket URLs for desktop mode', () => {
  assert.deepEqual(buildRuntimeConfig('http://127.0.0.1:3001'), {
    serverUrl: 'http://127.0.0.1:3001',
    apiBaseUrl: 'http://127.0.0.1:3001/api',
    wsUrl: 'http://127.0.0.1:3001',
    mode: 'remote-server'
  })
})
