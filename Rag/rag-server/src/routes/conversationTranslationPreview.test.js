const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const source = readFileSync(__dirname + '/conversations.js', 'utf8')

test('conversation translation preview route exists and checks conversation access', () => {
  const start = source.indexOf("router.post('/:id/translation-preview'")
  assert.ok(start >= 0)
  const end = source.indexOf("router.post('/:id/messages'", start)
  const block = source.slice(start, end)
  assert.match(block, /requireConversationAccess\(req, res, id\)/)
  assert.match(block, /translateFromChinese/)
  assert.match(block, /targetLanguageCode/)
})
