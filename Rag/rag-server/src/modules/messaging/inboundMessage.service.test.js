const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('events')
const { createInboundMessagePostProcessor } = require('./inboundMessage.service')

function createDependencies(poolType) {
  const calls = []
  return {
    calls,
    dependencies: {
      poolService: {
        routeIncomingMessage: async (...args) => {
          calls.push(['route', ...args])
          return { poolType, convStatus: poolType === 'ai_self' ? 'ai_serving' : 'pending_claim', claimedBy: null }
        }
      },
      configService: {
        getConfig: async key => {
          calls.push(['config', key])
          return 1200
        }
      },
      queueModule: {
        removePendingAiReplyJobs: async (...args) => { calls.push(['remove', ...args]) },
        markLatestAiReplyJob: async (...args) => { calls.push(['mark', ...args]) },
        aiReplyQueue: {
          add: async (...args) => {
            calls.push(['add', ...args])
            return { id: 'job-1' }
          }
        }
      },
      systemLogger: { info: (...args) => calls.push(['log', ...args]) },
      now: () => 1700000000000,
      random: () => 0.5
    }
  }
}

test('manual-only shop connection cancels pending AI jobs even when routed to AI pool', async () => {
  const { calls, dependencies } = createDependencies('ai_self')
  const processAfterStore = createInboundMessagePostProcessor(dependencies)
  const result = await processAfterStore({ conversationId: 'shop-conversation' }, null, { allowAutoReply: false })
  assert.equal(result.manualOnly, true)
  assert.equal(result.aiReplyQueued, false)
  assert.deepEqual(calls.map(call => call[0]), ['route', 'remove'])
})

test('AI 自助池入站消息通过公共服务加入 AI 回复队列', async () => {
  const { calls, dependencies } = createDependencies('ai_self')
  const processAfterStore = createInboundMessagePostProcessor(dependencies)
  const eventEmitter = new EventEmitter()
  const statuses = []
  eventEmitter.on('aiReplyStatus', payload => statuses.push(payload))
  const message = {
    conversationId: 'conversation-1',
    channel: 'wechat',
    accountId: 17,
    channelMessageId: 'message-1'
  }

  const result = await processAfterStore(message, eventEmitter, {
    source: 'cloud_gateway',
    eventId: 'event-1'
  })

  assert.equal(result.aiReplyQueued, true)
  assert.equal(result.jobId, 'job-1')
  assert.deepEqual(calls.map(call => call[0]), ['route', 'remove', 'config', 'mark', 'add', 'log'])
  const addCall = calls.find(call => call[0] === 'add')
  assert.equal(addCall[2].conversationId, 'conversation-1')
  assert.equal(addCall[2].eventId, 'event-1')
  assert.equal(addCall[2].source, 'cloud_gateway')
  assert.equal(addCall[3].delay, 1200)
  assert.deepEqual(statuses, [{
    conversationId: 'conversation-1',
    status: 'queued',
    jobId: 'job-1',
    jobMarker: result.jobMarker
  }])
})

test('非 AI 自助池入站消息只执行路由，不创建 AI 任务', async () => {
  const { calls, dependencies } = createDependencies('private')
  const processAfterStore = createInboundMessagePostProcessor(dependencies)

  const result = await processAfterStore({ conversationId: 'conversation-2' }, null, {
    source: 'cloud_gateway',
    eventId: 'event-2'
  })

  assert.equal(result.aiReplyQueued, false)
  assert.deepEqual(calls.map(call => call[0]), ['route'])
})


test('待人工会话不再加入AI队列', async () => {
  const { dependencies } = createDependencies('pending_human')
  assert.equal((await createInboundMessagePostProcessor(dependencies)({ conversationId: 'pending' })).aiReplyQueued, false)
})
test('人工认领后不创建AI任务', async () => {
  const { dependencies } = createDependencies('pending_human')
  dependencies.poolService.routeIncomingMessage = async () => ({ poolType: 'pending_human', convStatus: 'pending_claim', claimedBy: 1 })
  assert.equal((await createInboundMessagePostProcessor(dependencies)({ conversationId: 'claimed' })).aiReplyQueued, false)
})
