import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('login surface supports locked first-run owner setup without public registration', () => {
  const source = readFileSync(new URL('../../views/Login/LoginView.vue', import.meta.url), 'utf8')
  assert.match(source, /getSetupStatus/)
  assert.match(source, /setupOwner/)
  assert.match(source, /仅首次设置/)
  assert.match(source, /autocomplete="username"/)
  assert.match(source, /new-password/)
  assert.doesNotMatch(source, /注册账号|立即注册/)
})
