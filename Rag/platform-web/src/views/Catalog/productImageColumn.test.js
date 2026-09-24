import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('./components/ProductSkuPanel.vue', import.meta.url), 'utf8')

test('catalog product table renders imported product images with preview support', () => {
  assert.match(source, /row\.image_url/)
  assert.match(source, /preview-src-list/)
  assert.match(source, /product-thumbnail/)
})
