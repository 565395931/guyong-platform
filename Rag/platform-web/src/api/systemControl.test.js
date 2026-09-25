import test from 'node:test'
import assert from 'node:assert/strict'
import { restartBackend, waitForBackendRestart } from './systemControl.js'

test('restart request returns the previous backend pid', async () => {
  globalThis.localStorage = { getItem: () => 'test-token' }
  const data = await restartBackend(async (url, options) => {
    assert.match(url, /\/api\/v1\/system-control\/restart-backend$/)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return { ok: true, json: async () => ({ success: true, data: { previousPid: 12 } }) }
  })
  assert.equal(data.previousPid, 12)
})

test('restart wait tolerates downtime and resolves only for a new pid', async () => {
  const results = [new Error('offline'), { pid: 12 }, { pid: 24 }]
  const status = await waitForBackendRestart(12, {
    getStatus: async () => {
      const result = results.shift()
      if (result instanceof Error) throw result
      return result
    },
    wait: async () => {},
    timeoutMs: 100,
    now: (() => { let value = 0; return () => value += 10 })()
  })
  assert.equal(status.pid, 24)
})

test('restart request surfaces the server recovery message', async () => {
  globalThis.localStorage = { getItem: () => 'test-token' }
  await assert.rejects(
    restartBackend(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ success: false, message: '当前环境未启用本地后端重启功能' })
    })),
    /当前环境未启用/
  )
})
