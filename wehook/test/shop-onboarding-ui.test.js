const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

// Exercise the exact pure helpers shipped in the browser bundle, without executing its DOM bootstrap.
const source = fs.readFileSync(path.join(__dirname, '../cloud-console/public/assets/cloud.js'), 'utf8')
function browserHelper(name) {
  const start = source.indexOf(`  function ${name}(`)
  assert.notEqual(start, -1)
  const end = source.indexOf('\n  }', start) + '\n  }'.length
  return vm.runInNewContext(`${source.slice(start, end)}; ${name}`, {
    crypto: webcrypto,
    URL,
    Uint8Array,
    escapeHtml: value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])),
    btoa: value => Buffer.from(value, 'binary').toString('base64')
  })
}

test('shop callback generator produces shop-form-compatible 32-byte AES keys', () => {
  const generate = browserHelper('generateShopCallbackValues')
  const generated = new Set()
  for (let index = 0; index < 300; index += 1) {
    const values = generate()
    assert.match(values.token, /^[a-f0-9]{32}$/)
    assert.match(values.encodingAESKey, /^[a-zA-Z0-9]{43}$/)
    assert.equal(Buffer.from(values.encodingAESKey + '=', 'base64').length, 32)
    generated.add(values.encodingAESKey)
  }
  assert.equal(generated.size, 300)
})

test('shop address can be previewed before save using the same callback identity', () => {
  const callbackUrl = browserHelper('shopCallbackUrl')
  const id = webcrypto.randomUUID()
  assert.equal(callbackUrl(id, 'https://provider.example'), `https://provider.example/v1/shop/callback/${id}`)
  assert.ok(source.includes('body.callbackId = draft.id'))
  assert.ok(source.includes('body.draftRequired = true'))
  assert.ok(source.includes("'/v1/admin/shops/drafts'"))
  assert.doesNotMatch(source, /保存后生成此店铺专属的服务器地址/)
})

test('shop generator retries unsupported characters and bounds repeated failures', () => {
  const generate = browserHelper('generateShopCallbackValues')
  let calls = 0
  const values = generate({ getRandomValues(bytes) { calls += 1; bytes.fill(calls === 2 ? 255 : 0); return bytes } })
  assert.equal(calls, 3)
  assert.match(values.encodingAESKey, /^[a-zA-Z0-9]{43}$/)
  assert.throws(() => generate({ getRandomValues(bytes) { bytes.fill(255); return bytes } }), /小店页面随机生成/)
})

test('shop configuration is a plaintext copyable modal over the registered list', () => {
  const html = browserHelper('shopModalField')('appSecret', '小店 AppSecret', '<secret>"')
  assert.match(html, /type="text"/)
  assert.match(html, /&lt;secret&gt;&quot;/)
  assert.match(html, /data-shop-copy="appSecret"/)
  assert.doesNotMatch(html, /field-hint|type="password"/)
  assert.doesNotMatch(source, /function shopSetupGuide/)
  assert.ok(source.includes("leftAction: '重新生成新的回调'"))
  assert.ok(source.includes("confirm: '保存小店配置'"))
  assert.ok(source.includes('state.modalCleanup?.()'))
  assert.ok(source.includes('controller.abort(); root.replaceChildren(); app.inert = false'))
})
