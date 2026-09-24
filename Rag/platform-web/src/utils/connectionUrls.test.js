import test from 'node:test'
import assert from 'node:assert/strict'
import { apiUrl, assetUrl } from './connectionUrls.js'
import { loginUrl, redirectToLogin } from './sessionNavigation.js'

test('stream API targets the configured server and keeps the web proxy fallback', () => {
  assert.equal(apiUrl('/v1/messages/7/suggestions', 'https://service.example/api/'), 'https://service.example/api/v1/messages/7/suggestions')
  assert.equal(apiUrl('/v1/messages/7/suggestions', '/api'), '/api/v1/messages/7/suggestions')
})

test('server media resolves in file desktop without rewriting absolute or local previews', () => {
  assert.equal(assetUrl('/api/catalog/images/1.png', 'https://service.example'), 'https://service.example/api/catalog/images/1.png')
  for (const url of ['https://cdn.example/1.png', 'blob:local-preview', 'data:image/png;base64,YQ==', '']) {
    assert.equal(assetUrl(url, 'https://service.example'), url)
  }
  assert.equal(assetUrl('/api/images/1.png', ''), '/api/images/1.png')
  assert.equal(assetUrl('//cdn.example/1.png', 'https://service.example'), 'https://cdn.example/1.png')
})

test('desktop logout and expiry preserve the installed entry point', () => {
  assert.equal(loginUrl({ protocol: 'file:', href: 'file:///C:/Program%20Files/app/index.html#/orders' }), 'file:///C:/Program%20Files/app/index.html#/login')
  assert.equal(loginUrl({ protocol: 'https:', href: 'https://service.example/orders' }), '/login')
})

test('redirect clears only the application session before navigation', () => {
  const calls = []
  redirectToLogin({
    location: { protocol: 'file:', href: 'file:///app/index.html#/orders', replace: value => calls.push(value) },
    storage: { removeItem: key => calls.push(key) }
  })
  assert.deepEqual(calls, ['platform_token', 'platform_user', 'file:///app/index.html#/login'])
})
