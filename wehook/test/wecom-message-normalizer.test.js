const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeWecomMessage } = require('../src/wecom/messageNormalizer')

const RUNTIME = {
  connectionId: 8,
  accounts: [
    { accountId: 12, openKfId: 'wk-first' },
    { accountId: 13, openKfId: 'wk-second' }
  ]
}

test('normalizes a customer text message with stable account and message identifiers', () => {
  const normalized = normalizeWecomMessage({
    msgid: 'msg-1',
    open_kfid: 'wk-first',
    external_userid: 'external-1',
    send_time: 1700000000,
    origin: 3,
    msgtype: 'text',
    text: { content: 'hello' }
  }, RUNTIME)

  assert.deepEqual(normalized, {
    eventId: 'wecom:8:msg-1',
    payload: {
      channel: 'wecom_kf',
      accountId: 12,
      channelAccountId: 'wk-first',
      channelUserId: 'external-1',
      direction: 'inbound',
      messageType: 'text',
      content: { text: 'hello' },
      channelMessageId: 'msg-1',
      clientTimestamp: 1700000000000,
      metadata: { connectionId: 8, openKfId: 'wk-first', origin: 3 }
    }
  })
})

test('keeps the same customer isolated across different customer-service accounts', () => {
  const first = normalizeWecomMessage({
    msgid: 'msg-a', open_kfid: 'wk-first', external_userid: 'external-1',
    send_time: 1700000000, origin: 3, msgtype: 'text', text: { content: 'first' }
  }, RUNTIME)
  const second = normalizeWecomMessage({
    msgid: 'msg-b', open_kfid: 'wk-second', external_userid: 'external-1',
    send_time: 1700000001, origin: 3, msgtype: 'text', text: { content: 'second' }
  }, RUNTIME)

  assert.equal(first.payload.accountId, 12)
  assert.equal(second.payload.accountId, 13)
  assert.equal(first.payload.channelUserId, second.payload.channelUserId)
})

test('normalizes media, link and location metadata into Rag-supported message types', () => {
  const base = {
    open_kfid: 'wk-first', external_userid: 'external-1', send_time: 1700000000, origin: 3
  }
  assert.deepEqual(
    normalizeWecomMessage({ ...base, msgid: 'image-1', msgtype: 'image', image: { media_id: 'media-image' } }, RUNTIME).payload.content,
    { mediaId: 'media-image' }
  )
  assert.equal(
    normalizeWecomMessage({ ...base, msgid: 'voice-1', msgtype: 'voice', voice: { media_id: 'media-voice' } }, RUNTIME).payload.messageType,
    'audio'
  )
  assert.deepEqual(
    normalizeWecomMessage({ ...base, msgid: 'file-1', msgtype: 'file', file: { media_id: 'media-file', filename: 'quote.pdf' } }, RUNTIME).payload.content,
    { mediaId: 'media-file', fileName: 'quote.pdf' }
  )
  assert.equal(
    normalizeWecomMessage({ ...base, msgid: 'link-1', msgtype: 'link', link: { title: '产品', url: 'https://example.test/item' } }, RUNTIME).payload.messageType,
    'text'
  )
  assert.equal(
    normalizeWecomMessage({ ...base, msgid: 'location-1', msgtype: 'location', location: { name: '仓库', latitude: 31.2, longitude: 121.5 } }, RUNTIME).payload.content.text,
    '仓库'
  )
})

test('ignores non-customer messages, unsupported types and unknown accounts', () => {
  const base = {
    msgid: 'msg-1', open_kfid: 'wk-first', external_userid: 'external-1',
    send_time: 1700000000, origin: 3
  }
  assert.equal(normalizeWecomMessage({ ...base, origin: 5, msgtype: 'text', text: { content: 'agent' } }, RUNTIME), null)
  assert.equal(normalizeWecomMessage({ ...base, open_kfid: 'wk-unknown', msgtype: 'text', text: { content: 'unknown' } }, RUNTIME), null)
  assert.equal(normalizeWecomMessage({ ...base, msgtype: 'event', event: { event_type: 'session_status_change' } }, RUNTIME), null)
})

