const test = require('node:test')
const assert = require('node:assert/strict')
const GatewayInboundHandler = require('./gatewayInbound')
const GatewayAccountMapper = require('./gatewayAccount')

function fixture() {
  const stored = []
  const contexts = []
  const handler = new GatewayInboundHandler({
    accountMapper: new GatewayAccountMapper([{ accountId: 12, gatewayAccountId: 'shop-1', channel: 'wechat_shop' }]),
    messagingService: { processIncomingMessage: async message => { stored.push(message); return { id: 'local-1', conversationId: 'local-conversation' } } },
    inboundPostProcessor: async (_message, _emitter, context) => contexts.push(context)
  })
  const envelope = { eventId: 'event-1', payload: { accountId: 12, gatewayAccountId: 'shop-1', channel: 'wechat_shop', channelUserId: 'openid-1', messageType: 'text', content: { text: 'hello' } } }
  return { stored, contexts, handler, envelope }
}

test('shop inbound persists and defaults to manual-only without changing other channels', async () => {
  const f = fixture()
  const ack = await f.handler.handle(f.envelope)
  assert.equal(ack.status, 'processed')
  assert.equal(f.contexts[0].allowAutoReply, false)
  assert.equal(f.stored[0].conversationId, 'local-conversation')
})

test('shop inbound rejects crossed channel and shop bindings before persistence', async () => {
  for (const invalid of [{ channel: 'wecom_kf' }, { gatewayAccountId: 'another-shop' }]) {
    const f = fixture()
    Object.assign(f.envelope.payload, invalid)
    assert.equal((await f.handler.handle(f.envelope)).status, 'rejected')
    assert.equal(f.stored.length, 0)
  }
})

test('shop persistence failure is retryable and never runs the postprocessor', async () => {
  const f = fixture()
  f.handler.messagingService.processIncomingMessage = async () => { throw new Error('offline') }
  assert.equal((await f.handler.handle(f.envelope)).status, 'retryable_error')
  assert.equal(f.contexts.length, 0)
})
