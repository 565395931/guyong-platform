const test = require('node:test')
const assert = require('node:assert/strict')

const registry = require('./currentConversationRegistry')
const { createBridgeExpiryService } = require('./bridgeExpiryService')
const { createAccountSnapshotService } = require('./accountSnapshotService')

// 每个用例都从干净状态开始：registry 是模块级单例，用例之间会互相影响。
function authorizedSnapshotDb(db) {
  return { query: (sql, options) => /SELECT b.channel_account_id FROM desktop_bridge_bindings/.test(sql)
    ? Promise.resolve([{ channel_account_id: 4 }]) : db.query(sql, options) }
}

function resetRegistry() {
  registry.reset()
}

test('registry remembers the current conversation per account', () => {
  resetRegistry()
  registry.setCurrentKey(4, '01d3be83f264')
  assert.equal(registry.getCurrentKey(4), '01d3be83f264')
  assert.equal(registry.getCurrentKey(5), null)
  assert.equal(registry.isCurrent(4, '01d3be83f264'), true)
  assert.equal(registry.isCurrent(4, 'someone-else'), false)
})

test('registry drops the protection when the node reports no current conversation', () => {
  resetRegistry()
  registry.setCurrentKey(4, '01d3be83f264')
  // 读不到当前会话（窗口最小化、顶栏为空）时必须清除保护，
  // 否则一次残留会把这个会话永久护住，TTL 再也不归档它。
  registry.setCurrentKey(4, '')
  assert.equal(registry.getCurrentKey(4), null)
  assert.equal(registry.isCurrent(4, '01d3be83f264'), false)
})

test('registry ignores invalid account ids', () => {
  resetRegistry()
  assert.equal(registry.setCurrentKey('abc', 'key'), false)
  assert.equal(registry.setCurrentKey(0, 'key'), false)
  assert.equal(registry.getCurrentKey(undefined), null)
})

test('offline snapshots stop protecting a conversation after 45 seconds', t => {
  resetRegistry()
  let time = 1000
  t.mock.method(Date, 'now', () => time)
  registry.setCurrentKey(4, 'current')
  time += 45001
  assert.equal(registry.getCurrentKey(4), null)
})

test('snapshot from a node without an active account lease cannot archive conversations', async () => {
  resetRegistry()
  const queries = []
  const service = createAccountSnapshotService({ sequelize: { query: async sql => { queries.push(sql); return [] } } })
  const result = await service.handle({ nodeId: 88, envelope: { payload: { accounts: [{ accountId: 4, currentCustomerKey: 'fake' }] } } })
  assert.equal(result.errorCode, 'ACCOUNT_NOT_BOUND')
  assert.equal(registry.getCurrentKey(4), null)
  assert.equal(queries.some(sql => /UPDATE/.test(sql)), false)
})

test('snapshot registers the current key so the TTL sweep can skip it', async () => {
  resetRegistry()
  const sequelize = {
    query: async (sql) => {
      if (/SELECT user_id, conv_status/.test(sql)) {
        return [{ user_id: '01d3be83f264', conv_status: 'ai_serving' }]
      }
      return [{ affectedRows: 0 }]
    }
  }
  const service = createAccountSnapshotService({ sequelize: authorizedSnapshotDb(sequelize), logger: { info() {} } })
  await service.handle({ nodeId: 11,
    envelope: { payload: { accounts: [{ accountId: 4, currentCustomerKey: '01d3be83f264' }] } }
  })
  assert.equal(registry.getCurrentKey(4), '01d3be83f264')
})

test('snapshot does not register anything when the node cannot read the current conversation', async () => {
  resetRegistry()
  const sequelize = { query: async () => [[{ user_id: 'x', conv_status: 'ai_serving' }]] }
  const service = createAccountSnapshotService({ sequelize: authorizedSnapshotDb(sequelize), logger: { info() {} } })
  const result = await service.handle({ nodeId: 11,
    envelope: { payload: { accounts: [{ accountId: 4, currentCustomerKey: '' }] } }
  })
  assert.equal(registry.getCurrentKey(4), null)
  assert.equal(result.summary[0].skipped, 'no_current_customer')
})

test('expiry sweep archives idle conversations but skips the one the client has open', async () => {
  resetRegistry()
  registry.setCurrentKey(4, 'current-key')

  const updates = []
  const sequelize = {
    query: async (sql, options) => {
      if (/^\s*SELECT id, account_id, user_id/.test(sql)) {
        return [
          { id: 'conv-current', account_id: 4, user_id: 'current-key' },
          { id: 'conv-stale', account_id: 4, user_id: 'stale-key' },
          { id: 'conv-other-account', account_id: 5, user_id: 'whatever' }
        ]
      }
      updates.push(options.replacements.ids)
      return [{ affectedRows: options.replacements.ids.length }]
    }
  }

  const service = createBridgeExpiryService({ sequelize, logger: { info() {}, warn() {} } })
  const affected = await service.sweepOnce()

  // 当前会话被跳过：归档它会被 AccountSnapshot 立刻恢复，两者互相覆写
  // （实测表现为 conv_status 每 30 秒横跳一次、发送随机撞 409）。
  assert.deepEqual(updates, [['conv-stale', 'conv-other-account']])
  assert.equal(affected, 2)
})

test('expiry sweep writes nothing when every idle conversation is the current one', async () => {
  resetRegistry()
  registry.setCurrentKey(4, 'current-key')

  const updates = []
  const sequelize = {
    query: async (sql, options) => {
      if (/^\s*SELECT id, account_id, user_id/.test(sql)) {
        return [{ id: 'conv-current', account_id: 4, user_id: 'current-key' }]
      }
      updates.push(options)
      return [{ affectedRows: 0 }]
    }
  }

  const service = createBridgeExpiryService({ sequelize, logger: { info() {}, warn() {} } })
  assert.equal(await service.sweepOnce(), 0)
  assert.equal(updates.length, 0, '没有可归档的会话时不应发出 UPDATE')
})

test('expiry sweep keeps the TTL re-check inside the UPDATE', async () => {
  resetRegistry()
  let updateSql = ''
  const sequelize = {
    query: async (sql) => {
      if (/^\s*SELECT id, account_id, user_id/.test(sql)) {
        return [{ id: 'conv-stale', account_id: 4, user_id: 'stale-key' }]
      }
      updateSql = sql
      return [{ affectedRows: 1 }]
    }
  }

  const service = createBridgeExpiryService({ sequelize, logger: { info() {}, warn() {} } })
  await service.sweepOnce()

  // SELECT 到 UPDATE 之间可能来了新消息：last_message_time 已被刷新，
  // 这一行就不该再被归档，所以 TTL 条件必须在 UPDATE 里再判一次。
  assert.match(updateSql, /last_message_time < DATE_SUB\(NOW\(3\), INTERVAL :ttl MINUTE\)/)
  assert.match(updateSql, /conv_status <> 'archived'/)
})

// ========== 会话"还在不在客户端列表里" → 不在就归档 ==========

function createSnapshotStub({ known, activeKeys, currentKey, listReadable = true }) {
  const archived = []
  const restored = []
  const sequelize = {
    query: async (sql, options) => {
      // 注意：带 type: QueryTypes.SELECT 的查询，sequelize 直接返回行数组（不是 [rows, fields]）
      if (/SELECT user_id, conv_status/.test(sql)) return known
      if (/SET conv_status = CASE/.test(sql)) {
        restored.push(options.replacements.keys)
        return [{ affectedRows: options.replacements.keys.length }]
      }
      archived.push(options.replacements.keys)
      return [{ affectedRows: options.replacements.keys.length }]
    }
  }
  const service = createAccountSnapshotService({ sequelize: authorizedSnapshotDb(sequelize), logger: { info() {} } })
  return {
    service,
    archived,
    restored,
    run: () => service.handle({ nodeId: 11,
      envelope: {
        payload: {
          accounts: [{
            accountId: 4,
            currentCustomerKey: currentKey,
            activeConversationKeys: activeKeys,
            conversationListReadable: listReadable
          }]
        }
      }
    })
  }
}

test('archives conversations that disappeared from the client conversation list', async () => {
  resetRegistry()
  const stub = createSnapshotStub({
    known: [
      { user_id: 'current', conv_status: 'handling' },
      { user_id: 'still-in-list', conv_status: 'ai_serving' },
      { user_id: 'gone-from-list', conv_status: 'ai_serving' }
    ],
    activeKeys: ['current', 'still-in-list'],
    currentKey: 'current'
  })

  await stub.run()

  // 只有"客户端列表里已经没有了"的那条才归档；仍在列表里的不动
  assert.deepEqual(stub.archived, [['gone-from-list']])
  assert.deepEqual(stub.restored, [['current']])
})

test('archives everything missing from a readable list, including the conversation still in the topbar', async () => {
  resetRegistry()
  const stub = createSnapshotStub({
    known: [{ user_id: 'still-open', conv_status: 'ai_serving' }],
    // 客户端列表**可读但为空**（容器里只剩"暂无会话中用户"）：
    // 会话倒计时结束后会这样，但界面仍停在它上面、顶栏还显示着它。
    // 只看顶栏永远等不到归档 —— 实测就是这个场景。
    activeKeys: [],
    currentKey: 'still-open',
    listReadable: true
  })

  await stub.run()

  assert.deepEqual(stub.archived, [['still-open']])
  assert.deepEqual(stub.restored, [])
})

test('keeps the current conversation when the list cannot be read', async () => {
  resetRegistry()
  const stub = createSnapshotStub({
    known: [
      { user_id: 'current', conv_status: 'handling' },
      { user_id: 'other', conv_status: 'ai_serving' }
    ],
    activeKeys: [],
    currentKey: 'current',
    // 容器缺失/解析失败 → 不能把"读不到"当成"都不在列表里"，否则一次失败会清空所有会话
    listReadable: false
  })

  await stub.run()

  assert.deepEqual(stub.archived, [])
  assert.deepEqual(stub.restored, [['current']])
})

test('an older node without the readable flag keeps the conservative behaviour', async () => {
  resetRegistry()
  const stub = createSnapshotStub({
    known: [{ user_id: 'current', conv_status: 'ai_serving' }],
    activeKeys: [],
    currentKey: 'current'
  })
  // 不带 conversationListReadable 的旧节点：按"读不到"处理
  const sequelize = {
    query: async (sql, options) => {
      if (/SELECT user_id, conv_status/.test(sql)) return [{ user_id: 'current', conv_status: 'ai_serving' }]
      if (/SET conv_status = CASE/.test(sql)) return [{ affectedRows: 1 }]
      return [{ affectedRows: 0 }]
    }
  }
  const { createAccountSnapshotService } = require('./accountSnapshotService')
  const service = createAccountSnapshotService({ sequelize: authorizedSnapshotDb(sequelize), logger: { info() {} } })
  const result = await service.handle({ nodeId: 11,
    envelope: { payload: { accounts: [{ accountId: 4, currentCustomerKey: 'current', activeConversationKeys: [] }] } }
  })

  assert.equal(result.summary[0].conversationListReadable, false)
  assert.equal(result.summary[0].archived, 0)
})
