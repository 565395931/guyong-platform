import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const readSource = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('existing account views support embedding and external create/refresh commands', () => {
  const generic = readSource('../../views/Settings/AccountManage.vue')
  const wecom = readSource('../../views/Settings/PlatformAccountsView.vue')

  for (const source of [generic, wecom]) {
    assert.match(source, /embedded:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
    assert.match(source, /defineExpose/)
  }
  assert.match(generic, /channelCode:\s*\{\s*type:\s*String,\s*default:\s*''\s*\}/)
  assert.match(generic, /桌面节点/)
  assert.match(generic, /对话接入/)
})

test('unified account page switches between generic and WeCom management', () => {
  const viewUrl = new URL('../../views/Settings/CustomerServiceAccountsView.vue', import.meta.url)
  assert.equal(existsSync(viewUrl), true)
  const source = existsSync(viewUrl) ? readFileSync(viewUrl, 'utf8') : ''

  assert.match(source, /<AccountManage/)
  assert.match(source, /<PlatformAccountsView/)
  assert.match(source, /selectedChannel\s*=\s*ref\(normalizePlatformChannel\(route\.query\.channel\)\)/)
  assert.doesNotMatch(source, /v-model="selectedChannel"/)
  assert.match(source, /openCreate/)
  assert.match(source, /refresh/)
})

test('WeCom connection table surfaces callback activity for operators', () => {
  const source = readSource('../../views/Settings/components/ConnectionTable.vue')

  assert.match(source, /lastCallbackAt/)
  assert.match(source, /row\.callbackUrl/)
  assert.match(source, /复制回调地址/)
  assert.match(source, /navigator\.clipboard\.writeText/)
  assert.doesNotMatch(source, /callbackToken|encodingAesKey|corpSecret/)
  assert.match(source, /embedded:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
  assert.match(source, /props\.embedded\s*\?\s*280\s*:\s*500/)
  assert.match(source, /connection-actions/)
})

test('embedded WeCom account page uses compact connection layout', () => {
  const source = readSource('../../views/Settings/PlatformAccountsView.vue')

  assert.match(source, /:embedded="props\.embedded"/)
})
