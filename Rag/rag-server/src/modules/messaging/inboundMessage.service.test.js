const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('events')
const { createInboundMessagePostProcessor } = require('./inboundMessage.service')

function createDependencies(poolType) {
  const calls = []
  return {
    calls,
    dependencies: {
      reviewService: {
        reviewInbound: async (...args) => {
          calls.push(['review', ...args])
          return { action: 'allow' }
        }
      },
      poolService: {
        routeIncomingMessage: async (...args) => {
          calls.push(['route', ...args])
          return { poolType }
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
  assert.deepEqual(calls.map(call => call[0]), ['review', 'route', 'remove', 'config', 'mark', 'add', 'log'])
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
  const { calls, dependencies } = createDependencies('pending_human')
  const processAfterStore = createInboundMessagePostProcessor(dependencies)

  const result = await processAfterStore({ conversationId: 'conversation-2' }, null, {
    source: 'cloud_gateway',
    eventId: 'event-2'
  })

  assert.equal(result.aiReplyQueued, false)
  assert.deepEqual(calls.map(call => call[0]), ['review', 'route'])
})

test('待人工审核消息不会进入会话路由或 AI 回复队列', async () => {
  const { calls, dependencies } = createDependencies('ai_self')
  dependencies.reviewService.reviewInbound = async (...args) => {
    calls.push(['review', ...args])
    return { action: 'review', item: { id: 'review-1' } }
  }
  const processAfterStore = createInboundMessagePostProcessor(dependencies)

  const result = await processAfterStore({
    id: 'message-3',
    conversationId: 'conversation-3',
    content: { text: 'suspicious' }
  }, null, { source: 'cloud_gateway', eventId: 'event-3' })

  assert.deepEqual(result, {
    reviewQueued: true,
    reviewId: 'review-1',
    aiReplyQueued: false,
    jobMarker: null
  })
  assert.deepEqual(calls.map(call => call[0]), ['review', 'remove'])
})

test('审核任务已创建时，清理旧 AI 任务失败也不会继续路由', async () => {
  const { calls, dependencies } = createDependencies('ai_self')
  dependencies.reviewService.reviewInbound = async () => ({ action: 'review', item: { id: 'review-2' } })
  dependencies.queueModule.removePendingAiReplyJobs = async () => { throw new Error('redis unavailable') }
  const processAfterStore = createInboundMessagePostProcessor(dependencies)

  const result = await processAfterStore({ id: 'message-4', conversationId: 'conversation-4' })
  assert.equal(result.reviewQueued, true)
  assert.equal(calls.some(call => call[0] === 'route'), false)
})
