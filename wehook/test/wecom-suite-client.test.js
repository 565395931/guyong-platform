const test = require('node:test')
const assert = require('node:assert/strict')
const { createWecomSuiteClient } = require('../src/wecom/wecomSuiteClient')

test('exchanges suite authorization, syncs customer messages and sends text', async () => {
  const calls = []
  const mediaCalls = []
  const client = createWecomSuiteClient({ request: async input => {
    calls.push(input)
    if (input.path.endsWith('get_suite_token')) return { errcode: 0, suite_access_token: 'suite-access', expires_in: 7200 }
    if (input.path.endsWith('get_permanent_code')) return { errcode: 0, permanent_code: 'permanent-1', auth_corp_info: { corpid: 'wwCorp1', corp_name: '测试公司' }, auth_info: {} }
    if (input.path.endsWith('get_pre_auth_code')) return { errcode: 0, pre_auth_code: 'pre-auth-1', expires_in: 1200 }
    if (input.path.endsWith('set_session_info')) return { errcode: 0, errmsg: 'ok' }
    if (input.path.endsWith('get_corp_token')) return { errcode: 0, access_token: 'corp-access', expires_in: 7200 }
    if (input.path.endsWith('sync_msg')) return { errcode: 0, msg_list: [{ msgid: 'in-1' }], next_cursor: 'cursor-1', has_more: 0 }
    if (input.path.endsWith('send_msg')) return { errcode: 0, msgid: 'out-1' }
    throw new Error('unexpected request')
  }, mediaRequest: async input => { mediaCalls.push(input); return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' } }, now: () => 1000 })
  const config = { suiteId: 'wwSuite1', suiteSecret: 'secret', suiteTicket: 'ticket' }
  const authorized = await client.exchangeAuthCode(config, 'auth-code')
  assert.equal(authorized.corpId, 'wwCorp1')
  const preAuth = await client.getPreAuthCode(config)
  assert.equal(preAuth.preAuthCode, 'pre-auth-1')
  await client.setSessionInfo(config, preAuth.preAuthCode, 1)
  const sessionCall = calls.find(item => item.path.endsWith('set_session_info'))
  assert.deepEqual(sessionCall.body, { pre_auth_code: 'pre-auth-1', session_info: { auth_type: 1 } })
  const installation = { corpId: authorized.corpId, permanentCode: authorized.permanentCode }
  const synced = await client.syncMessages(config, installation, { token: 'sync-token', openKfId: 'wk-1' })
  assert.equal(synced.messages.length, 1)
  const sent = await client.sendText(config, installation, { openKfId: 'wk-1', externalUserId: 'external-1', text: '您好' })
  assert.equal(sent.channelMessageId, 'out-1')
  const media = await client.downloadMedia(config, installation, 'media-1')
  assert.equal(media.buffer.length, 4)
  assert.equal(mediaCalls[0].path, '/cgi-bin/media/get')
  assert.equal(mediaCalls[0].query.media_id, 'media-1')
  assert.equal(mediaCalls[0].query.access_token, 'corp-access')
  assert.equal(calls.filter(item => item.path.endsWith('get_suite_token')).length, 1)
  assert.equal(calls.filter(item => item.path.endsWith('get_corp_token')).length, 1)
})
