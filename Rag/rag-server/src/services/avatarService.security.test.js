const test = require('node:test')
const assert = require('node:assert/strict')

const { isAllowedAvatarUrl, extractAvatarUrl } = require('./avatarService')

test('avatar URLs are limited to HTTPS WhatsApp or Meta CDN hosts', () => {
  assert.equal(isAllowedAvatarUrl('https://pps.whatsapp.net/v/test.jpg'), true)
  assert.equal(isAllowedAvatarUrl('https://lookaside.fbsbx.com/avatar.jpg'), true)
  assert.equal(isAllowedAvatarUrl('http://pps.whatsapp.net/v/test.jpg'), false)
  assert.equal(isAllowedAvatarUrl('https://127.0.0.1/avatar.jpg'), false)
  assert.equal(isAllowedAvatarUrl('https://169.254.169.254/latest/meta-data'), false)
  assert.equal(isAllowedAvatarUrl('https://pps.whatsapp.net.evil.example/avatar.jpg'), false)
  assert.equal(isAllowedAvatarUrl('https://user:password@pps.whatsapp.net/avatar.jpg'), false)
})

test('additional avatar hosts require explicit configuration', () => {
  assert.equal(isAllowedAvatarUrl('https://cdn.example.com/avatar.jpg'), false)
  assert.equal(isAllowedAvatarUrl(
    'https://img.cdn.example.com/avatar.jpg',
    { AVATAR_ALLOWED_HOSTS: 'cdn.example.com' }
  ), true)
})

test('unsafe upstream avatar payloads are rejected before download', () => {
  assert.equal(extractAvatarUrl({ url: 'http://127.0.0.1/private' }), null)
  assert.equal(extractAvatarUrl({ url: 'https://pps.whatsapp.net/avatar.jpg' }), 'https://pps.whatsapp.net/avatar.jpg')
})
