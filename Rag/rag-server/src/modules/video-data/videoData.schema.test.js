const test = require('node:test')
const assert = require('node:assert/strict')

const { ensureVideoDataSchema, VIDEO_DATA_SCHEMA_STATEMENTS } = require('./videoData.schema')

test('video data schema creates the management table', async () => {
  const statements = []
  await ensureVideoDataSchema({
    query: async sql => statements.push(sql)
  })

  assert.equal(statements.length, VIDEO_DATA_SCHEMA_STATEMENTS.length)
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS video_account_data/i)
})

