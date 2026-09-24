import test from 'node:test'
import assert from 'node:assert/strict'

import { createReviewCounter, formatReviewCount, normalizeReviewCount } from './reviewCount.js'

test('review count uses the total visible queue and formats large values', () => {
  assert.equal(normalizeReviewCount({ all: 7, mine: 2, public: 3 }), 7)
  assert.equal(normalizeReviewCount({ mine: 2, public: 3 }), 5)
  assert.equal(normalizeReviewCount({}), 0)
  assert.equal(formatReviewCount(100), '99+')
  assert.equal(formatReviewCount(8), '8')
})

test('review counter refreshes on start and websocket updates, then cleans up', async () => {
  const handlers = new Map()
  const socket = {
    on(event, handler) { handlers.set(event, handler) },
    off(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event)
    }
  }
  let calls = 0
  let intervalCallback
  let clearedTimer
  const counter = createReviewCounter({
    fetchStats: async () => ({ data: { all: ++calls } }),
    websocket: socket,
    setIntervalFn(callback) {
      intervalCallback = callback
      return 42
    },
    clearIntervalFn(timer) { clearedTimer = timer }
  })

  counter.start()
  await counter.refreshing
  assert.equal(counter.count.value, 1)
  assert.equal(typeof intervalCallback, 'function')

  handlers.get('message_review_updated')()
  await counter.refreshing
  assert.equal(counter.count.value, 2)

  counter.stop()
  assert.equal(clearedTimer, 42)
  assert.equal(handlers.has('message_review_updated'), false)
})
