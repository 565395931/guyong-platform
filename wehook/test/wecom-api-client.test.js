const test = require('node:test')
const assert = require('node:assert/strict')

const { createWecomApiClient } = require('../src/wecom/wecomApiClient')

const CONFIG = { corpId: 'ww-test', secret: 'secret-value' }

test('coalesces concurrent access-token refreshes and pulls sync_msg pages', async () => {
  let tokenRequests = 0
  let syncRequests = 0
  const request = async ({ path, body, query }) => {
    if (path === '/cgi-bin/gettoken') {
      tokenRequests += 1
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(query.corpid, 'ww-test')
      return { errcode: 0, access_token: 'access-1', expires_in: 7200 }
    }
    syncRequests += 1
    assert.equal(query.access_token, 'access-1')
    assert.equal(body.token, 'sync-token')
    return {
      errcode: 0,
      next_cursor: 'cursor-2',
      has_more: 0,
      msg_list: [{ msgid: `msg-${syncRequests}` }]
    }
  }
  const client = createWecomApiClient({ request, now: () => 1000 })

  const [first, second] = await Promise.all([
    client.syncMessages(CONFIG, { token: 'sync-token', cursor: '' }),
    client.syncMessages(CONFIG, { token: 'sync-token', cursor: '' })
  ])

  assert.equal(tokenRequests, 1)
  assert.equal(syncRequests, 2)
  assert.equal(first.messages.length, 1)
  assert.equal(second.nextCursor, 'cursor-2')
  assert.equal(second.hasMore, false)
})

test('refreshes an expired token once and redacts credentials from errors', async () => {
  let tokenRequests = 0
  let syncRequests = 0
  const request = async ({ path }) => {
    if (path === '/cgi-bin/gettoken') {
      tokenRequests += 1
      return { errcode: 0, access_token: `access-${tokenRequests}`, expires_in: 7200 }
    }
    syncRequests += 1
    if (syncRequests === 1) return { errcode: 42001, errmsg: 'access_token=access-1 expired' }
    return { errcode: 0, next_cursor: '', has_more: 0, msg_list: [] }
  }
  const client = createWecomApiClient({ request, now: () => 1000 })

  await client.syncMessages(CONFIG, { token: 'sync-token' })

  assert.equal(tokenRequests, 2)
  assert.equal(syncRequests, 2)

  const failingClient = createWecomApiClient({
    request: async () => ({ errcode: 40013, errmsg: 'secret=secret-value access_token=access-leak' })
  })
  await assert.rejects(
    failingClient.syncMessages(CONFIG, { token: 'sync-token' }),
    error => !error.message.includes('secret-value') && !error.message.includes('access-leak')
  )
})

test('builds a text send_msg request with the original account and customer ids', async () => {
  const calls = []
  const client = createWecomApiClient({
    request: async input => {
      calls.push(input)
      if (input.path === '/cgi-bin/gettoken') return { errcode: 0, access_token: 'access-1', expires_in: 7200 }
      return { errcode: 0, msgid: 'platform-message-1' }
    }
  })

  const result = await client.sendTextMessage(CONFIG, {
    openKfId: 'wk-test',
    externalUserId: 'external-1',
    text: 'hello'
  })

  assert.deepEqual(result, { channelMessageId: 'platform-message-1' })
  assert.deepEqual(calls[1].body, {
    touser: 'external-1',
    open_kfid: 'wk-test',
    msgtype: 'text',
    text: { content: 'hello' }
  })
})

