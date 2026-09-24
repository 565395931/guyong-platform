const test = require('node:test')
const assert = require('node:assert/strict')

const { createCustomerOperationsTimer } = require('./customerOperations.timer')

test('timer prevents overlapping work and unrefs its interval', async () => {
  const intervals = []
  const cleared = []
  let release
  let calls = 0
  const pending = new Promise(resolve => { release = resolve })
  const timerHandle = { unrefCalls: 0, unref() { this.unrefCalls += 1 } }

  const timer = createCustomerOperationsTimer({
    runPendingWork: async () => {
      calls += 1
      await pending
    },
    setIntervalFn(callback, milliseconds) {
      intervals.push({ callback, milliseconds })
      return timerHandle
    },
    clearIntervalFn(handle) { cleared.push(handle) }
  })

  timer.start()
  assert.equal(intervals[0].milliseconds, 60000)
  assert.equal(timerHandle.unrefCalls, 1)

  const first = intervals[0].callback()
  const second = intervals[0].callback()
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  await Promise.all([first, second])

  timer.stop()
  assert.deepEqual(cleared, [timerHandle])
})
