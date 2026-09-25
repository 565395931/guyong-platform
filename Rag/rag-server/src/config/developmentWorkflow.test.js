const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

test('development backend restarts when imported source files change', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
  assert.equal(packageJson.scripts.dev, 'node --watch src/app.js')
})
