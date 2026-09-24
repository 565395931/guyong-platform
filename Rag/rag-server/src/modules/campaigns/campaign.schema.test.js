const test = require('node:test')
const assert = require('node:assert/strict')

const { ensureCampaignSchema, CAMPAIGN_SCHEMA_STATEMENTS } = require('./campaign.schema')

test('campaign schema exposes task and delivery tables', async () => {
  const statements = []

  await ensureCampaignSchema({
    query: async sql => statements.push(sql)
  })

  assert.equal(statements.length, CAMPAIGN_SCHEMA_STATEMENTS.length)
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS campaign_tasks/i)
  assert.match(statements[1], /CREATE TABLE IF NOT EXISTS campaign_deliveries/i)
})

