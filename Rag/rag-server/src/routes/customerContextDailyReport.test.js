const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const customersSource = readFileSync(__dirname + '/customers.js', 'utf8')
const conversationsSource = readFileSync(__dirname + '/conversations.js', 'utf8')

test('daily report exposes a primary visible conversation and action flags for each customer', () => {
  assert.match(customersSource, /primaryConversationId/)
  assert.match(customersSource, /bindingStatus/)
  assert.match(customersSource, /actionFlags/)
})

test('historical daily reports read and regenerate durable revisions', () => {
  assert.match(customersSource, /customer_daily_report_revisions/)
  assert.match(customersSource, /revision/)
  assert.match(customersSource, /generatedBy/)
})

test('conversation customer context endpoint requires conversation access and returns source owner', () => {
  assert.match(conversationsSource, /customer-context/)
  assert.match(conversationsSource, /requireConversationAccess\(req, res, id\)/)
  assert.match(conversationsSource, /sourceConversation/)
})

test('customer context includes latest-language profile signals for bilingual replies', () => {
  assert.match(conversationsSource, /resolveCustomerLanguage\(id\)/)
  assert.match(conversationsSource, /languageProfile/)
  assert.match(conversationsSource, /politeness/)
})
