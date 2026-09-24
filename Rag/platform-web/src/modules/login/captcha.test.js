import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { normalizeCaptchaCode } from './captcha.js'

test('normalizes captcha input before submit', () => {
  assert.equal(normalizeCaptchaCode(' a b 1 2 '), 'AB12')
  assert.equal(normalizeCaptchaCode(' 7z-9 '), '7Z-9')
})

test('login form no longer renders captcha controls', () => {
  const source = readFileSync(new URL('../../views/Login/LoginView.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /captchaCode/)
  assert.doesNotMatch(source, /captchaImage/)
  assert.doesNotMatch(source, /getLoginCaptcha/)
  assert.doesNotMatch(source, /loadCaptcha/)
})
