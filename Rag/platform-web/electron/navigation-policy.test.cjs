const test = require('node:test')
const assert = require('node:assert/strict')
const { isAllowedNavigation } = require('./navigation-policy.cjs')

test('packaged window may only navigate to its own entry document', () => {
  const entry = 'file:///C:/app/dist/index.html'
  assert.equal(isAllowedNavigation(entry + '#/login', entry), true)
  for (const url of ['file:///C:/private.txt', entry + '?x=1', 'https://example.com', 'not a url']) {
    assert.equal(isAllowedNavigation(url, entry), false)
  }
})

test('development navigation compares origins rather than string prefixes', () => {
  const entry = 'http://localhost:3003'
  assert.equal(isAllowedNavigation(entry + '/login', entry, true), true)
  assert.equal(isAllowedNavigation('http://localhost:30030', entry, true), false)
  assert.equal(isAllowedNavigation('http://localhost:3003@evil.example', entry, true), false)
})
