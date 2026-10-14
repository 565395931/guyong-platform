const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createBridgeRepository } = require('./bridgeRepository')

/**
 * upsertBinding 是 leaseService.assertBinding 的前置条件——没有启用状态的绑定行，
 * acquire 必抛 ACCOUNT_NOT_BOUND。这里用假 sequelize 断言 SQL 与参数绑定。
 */
function createFakeSequelize() {
  const calls = []
  // 模拟真实持久化：INSERT 存下这一行，随后的 SELECT 读回同一行。
  // 若让 SELECT 从自己的 replacements 造数据，adapter_id 必然是 undefined，
  // 断言就变成假通过了。
  let stored = null
  return {
    calls,
    get stored() {
      return stored
    },
    async query(sql, options = {}) {
      calls.push({
        sql,
        replacements: options.replacements,
        hasTransaction: Boolean(options.transaction)
      })
      if (/INSERT INTO desktop_bridge_bindings/i.test(sql)) {
        stored = {
          id: 1,
          channel_account_id: options.replacements.accountId,
          preferred_node_id: options.replacements.preferredNodeId ?? null,
          adapter_id: options.replacements.adapterId,
          mode: options.replacements.mode,
          ai_mode: options.replacements.aiMode,
          enabled: options.replacements.enabled
        }
        return []
      }
      if (/SELECT \* FROM desktop_bridge_bindings/i.test(sql)) {
        return stored ? [stored] : []
      }
      return []
    },
    async transaction(fn) {
      return fn({ id: 'tx-1' })
    }
  }
}

test('upsertBinding 写入绑定并使用 ON DUPLICATE KEY UPDATE 保证幂等', async () => {
  const sequelize = createFakeSequelize()
  const repository = createBridgeRepository(sequelize)

  const binding = await repository.upsertBinding({
    channelAccountId: 7,
    adapterId: 'doudian.feige',
    preferredNodeId: 3
  })

  const insert = sequelize.calls.find(call => /INSERT INTO desktop_bridge_bindings/i.test(call.sql))
  assert.ok(insert, '应写入 desktop_bridge_bindings')
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/)
  assert.match(insert.sql, /channel_account_id/)
  assert.match(insert.sql, /adapter_id/)
  assert.equal(insert.replacements.accountId, 7)
  assert.equal(insert.replacements.adapterId, 'doudian.feige')
  assert.equal(insert.replacements.preferredNodeId, 3)
  assert.equal(insert.replacements.mode, 'desktop_bridge')
  assert.equal(insert.replacements.enabled, 1)
  assert.equal(binding.adapterId, 'doudian.feige')
})

test('upsertBinding 使用命名参数而不是拼接原始值', async () => {
  const sequelize = createFakeSequelize()
  const repository = createBridgeRepository(sequelize)

  await repository.upsertBinding({ channelAccountId: 11, adapterId: 'doudian.feige' })

  const insert = sequelize.calls.find(call => /INSERT INTO desktop_bridge_bindings/i.test(call.sql))
  // SQL 文本里只能出现占位符，不能出现具体值
  assert.equal(insert.sql.includes('11'), false)
  assert.equal(insert.sql.includes('doudian.feige'), false)
  assert.match(insert.sql, /:accountId/)
  assert.match(insert.sql, /:adapterId/)
})

test('upsertBinding 在外部事务中复用该事务而不是另开一个', async () => {
  const sequelize = createFakeSequelize()
  const repository = createBridgeRepository(sequelize)
  const outerTx = { id: 'outer-tx' }

  await repository.upsertBinding({
    channelAccountId: 5,
    adapterId: 'doudian.feige',
    transaction: outerTx
  })

  for (const call of sequelize.calls) {
    assert.equal(call.hasTransaction, true, '所有语句都应带上外部事务')
  }
})

test('upsertBinding 默认自行开启事务', async () => {
  const sequelize = createFakeSequelize()
  const repository = createBridgeRepository(sequelize)

  await repository.upsertBinding({ channelAccountId: 5, adapterId: 'doudian.feige' })

  assert.ok(sequelize.calls.length >= 2)
  for (const call of sequelize.calls) {
    assert.equal(call.hasTransaction, true)
  }
})

test('upsertBinding 拒绝非法 channelAccountId', async () => {
  const repository = createBridgeRepository(createFakeSequelize())
  for (const bad of [0, -1, 'abc', null, undefined]) {
    await assert.rejects(
      () => repository.upsertBinding({ channelAccountId: bad, adapterId: 'doudian.feige' }),
      error => {
        assert.equal(error.code, 'BINDING_INVALID_ACCOUNT')
        return true
      }
    )
  }
})

test('upsertBinding 要求 adapterId 非空', async () => {
  const repository = createBridgeRepository(createFakeSequelize())
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(
      () => repository.upsertBinding({ channelAccountId: 1, adapterId: bad }),
      error => {
        assert.equal(error.code, 'BINDING_INVALID_ADAPTER')
        return true
      }
    )
  }
})

test('upsertBinding 拒绝未知 mode', async () => {
  const repository = createBridgeRepository(createFakeSequelize())
  await assert.rejects(
    () => repository.upsertBinding({ channelAccountId: 1, adapterId: 'a', mode: 'bogus' }),
    error => {
      assert.equal(error.code, 'BINDING_INVALID_MODE')
      return true
    }
  )
})

test('enabled 为假时写入 0', async () => {
  const sequelize = createFakeSequelize()
  const repository = createBridgeRepository(sequelize)
  await repository.upsertBinding({ channelAccountId: 9, adapterId: 'a', enabled: 0 })
  const insert = sequelize.calls.find(call => /INSERT INTO desktop_bridge_bindings/i.test(call.sql))
  assert.equal(insert.replacements.enabled, 0)
})

test('建号路由确实接入了桌面桥接分支（源码断言）', () => {
  const source = fs.readFileSync(require.resolve('../../routes/channelAccounts'), 'utf8')
  assert.match(source, /prepareDesktopBridgeAccountCreation/)
  assert.match(source, /connection_mode/)
  assert.match(source, /desktop_bridge/)
  // 绑定必须与建号同事务，否则账号建出来也无法获取租约
  assert.match(source, /upsertBinding/)
  assert.match(source, /sequelize\.transaction/)
  assert.match(source, /router\.post\('\/detect-desktop'/)
})

test('检测路由按渠道选择探针（源码断言）', () => {
  const source = fs.readFileSync(require.resolve('../../routes/channelAccounts'), 'utf8')
  // 每渠道一个探针：douyin → feige，xiaohongshu → qianfan
  assert.match(source, /DESKTOP_PROBE_CONFIGS/)
  assert.match(source, /feige-uia-probe/)
  assert.match(source, /qianfan-uia-probe/)
  assert.match(source, /QIANFAN_PROBE_PATH/)
  assert.match(source, /probeConfig\.pythonEnv/)
  // 建号时把渠道透传给 prepare，由其决定 adapterId
  assert.match(source, /prepareDesktopBridgeAccountCreation\(\{ config, channel: channelCode \}\)/)
})
