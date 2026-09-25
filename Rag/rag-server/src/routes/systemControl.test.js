const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const http = require('http')
const { createSystemControlRouter, isRestartEnabled, requireAdministrator } = require('./systemControl')

async function withServer(router, run) {
  const app = express()
  app.use('/api/v1/system-control', router)
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('restart is enabled by default only for non-production Windows', () => {
  assert.equal(isRestartEnabled({ NODE_ENV: 'development' }, 'win32'), true)
  assert.equal(isRestartEnabled({ NODE_ENV: 'production' }, 'win32'), false)
  assert.equal(isRestartEnabled({ LOCAL_BACKEND_RESTART_ENABLED: 'true', NODE_ENV: 'production' }, 'win32'), true)
  assert.equal(isRestartEnabled({ LOCAL_BACKEND_RESTART_ENABLED: 'false' }, 'win32'), false)
  assert.equal(isRestartEnabled({ LOCAL_BACKEND_RESTART_ENABLED: 'true' }, 'linux'), false)
})

test('administrator middleware rejects other roles', () => {
  let nextCalls = 0
  requireAdministrator({ user: { role: 'admin' } }, {}, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)

  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
  requireAdministrator({ user: { role: 'agent' } }, response, () => { nextCalls += 1 })
  assert.equal(response.statusCode, 403)
  assert.equal(response.body.success, false)
})

test('restart endpoint launches the helper and exits only after the response finishes', async () => {
  const launches = []
  const scheduled = []
  const exits = []
  const router = createSystemControlRouter({
    authenticate: (req, res, next) => { req.user = { role: 'admin' }; next() },
    environment: { NODE_ENV: 'development' },
    platform: 'win32',
    currentPid: 4321,
    startedAt: '2026-09-25T00:00:00.000Z',
    launchRestart: options => launches.push(options),
    scheduleExit: (callback, delay) => scheduled.push({ callback, delay }),
    exitProcess: code => exits.push(code)
  })

  await withServer(router, async base => {
    const statusResponse = await fetch(`${base}/api/v1/system-control/status`)
    const status = await statusResponse.json()
    assert.equal(status.data.pid, 4321)
    assert.equal(status.data.restartEnabled, true)

    const restartResponse = await fetch(`${base}/api/v1/system-control/restart-backend`, { method: 'POST' })
    const restart = await restartResponse.json()
    assert.equal(restartResponse.status, 202)
    assert.equal(restart.data.previousPid, 4321)
    assert.deepEqual(launches, [{ currentPid: 4321, port: 3001 }])
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].delay, 300)
    assert.deepEqual(exits, [])

    scheduled[0].callback()
    assert.deepEqual(exits, [0])

    const duplicateResponse = await fetch(`${base}/api/v1/system-control/restart-backend`, { method: 'POST' })
    assert.equal(duplicateResponse.status, 409)
  })
})

test('restart endpoint stays unavailable when explicitly disabled', async () => {
  const router = createSystemControlRouter({
    authenticate: (req, res, next) => { req.user = { role: 'admin' }; next() },
    environment: { LOCAL_BACKEND_RESTART_ENABLED: 'false' },
    platform: 'win32'
  })
  await withServer(router, async base => {
    const response = await fetch(`${base}/api/v1/system-control/restart-backend`, { method: 'POST' })
    assert.equal(response.status, 403)
  })
})
