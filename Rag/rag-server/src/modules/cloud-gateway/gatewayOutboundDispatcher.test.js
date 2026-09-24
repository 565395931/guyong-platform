const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('events')

const { initCloudGateway } = require('./index')

test('dispatches WeCom messages through the cloud gateway without static account env mapping', async () => {
  const sent = []
  const fakeLink = new EventEmitter()
  fakeLink.start = () => {}
  fakeLink.send = envelope => { sent.push(envelope) }

  const gateway = initCloudGateway({
    eventEmitter: new EventEmitter(),
    accountEntries: [],
    options: {
      link: fakeLink,
      enabled: true,
      adapterResolver: () => null
    }
  })

  const result = await gateway.dispatcher.dispatch({
    commandId: 'cmd-1',
    conversationId: 'conversation-1',
    localMessageId: 'message-1',
    channel: 'wecom_kf',
    accountId: 17,
    targetUserId: 'external-user-1',
    messageType: 'text',
    content: { text: 'hello' }
  })

  assert.equal(result.transport, 'cloud_gateway')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'channel.message.send')
  assert.equal(sent[0].payload.channel, 'wecom_kf')
  assert.equal(sent[0].payload.accountId, 17)
})
