const test = require('node:test')
const assert = require('node:assert/strict')
const { createBridgeCommandService } = require('./bridgeCommandService')

test('accepted only acknowledges receipt; only succeeded completes a send and removes its waiter', async () => {
  let dispatched
  const ready = new Promise(resolve => { dispatched = resolve })
  const service = createBridgeCommandService({
    timeoutMs: 1000,
    sequelize: { query: async sql => {
      if (/SELECT l.node_id/.test(sql)) return [{ node_id: 11, node_key: '00000000-0000-4000-8000-000000000011' }]
      if (/SELECT node_id, state/.test(sql)) return [{ node_id: 11, state: 'dispatching' }]
      return [{ affectedRows: 1 }]
    } },
    registry: { get: () => ({ socket: { send: raw => dispatched(JSON.parse(raw)) } }) }
  })
  let completed = false
  const result = service.sendMessage({ accountId: 1, targetUserId: 'synthetic-customer', content: 'synthetic' })
    .then(value => { completed = true; return value })
  const command = await ready
  const status = value => ({ nodeId: 11, envelope: { payload: { commandId: command.commandId, status: value } } })
  assert.equal((await service.handleStatus(status('accepted'))).status, 'processed')
  assert.equal(completed, false)
  assert.equal(service._pending.size, 1)
  assert.equal((await service.handleStatus({ ...status('succeeded'), nodeId: 99 })).errorCode, 'COMMAND_NODE_MISMATCH')
  await service.handleStatus(status('succeeded'))
  assert.equal((await result).success, true)
  assert.equal(service._pending.size, 0)
})

test('late accepted cannot overwrite a completed send', async () => {
  let updates = 0
  const service = createBridgeCommandService({
    sequelize: { query: async sql => {
      if (/SELECT node_id/.test(sql)) return [{ node_id: 11, state: 'succeeded' }]
      updates += 1
      return []
    } }, registry: {}
  })
  assert.equal((await service.handleStatus({ nodeId: 11, envelope: { payload: { commandId: 'synthetic', status: 'accepted' } } })).status, 'duplicate')
  assert.equal(updates, 0)
})
