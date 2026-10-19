const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ADAPTER_CHANNEL_MAP,
  ORDER_STATUS,
  STATUS_MAP,
  createScrapedOrderIngestService,
  mapOrderRow,
  parseChinaTime
} = require('./scrapedOrderIngestService')

function createFakeSequelize({ existingOrderNos = [], accountRow = { id: 9 }, existingOwner = { channel: 'xiaohongshu', account_id: 9 } } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, options = {}) {
      calls.push({
        sql,
        replacements: options.replacements,
        hasTransaction: Boolean(options.transaction)
      })
      if (/FROM channel_accounts/i.test(sql)) {
        return [accountRow ? [accountRow] : []]
      }
      if (/SELECT id, channel, account_id FROM orders WHERE order_no/i.test(sql)) {
        const found = existingOrderNos.includes(options.replacements.orderNo)
        return [found ? [{ id: 'existing-order', ...existingOwner }] : []]
      }
      return []
    },
    // 与服务实现一致：手动事务（transaction() → commit/rollback），不是回调形式
    async transaction() {
      return {
        id: 'tx-1',
        committed: false,
        rolledBack: false,
        async commit() { this.committed = true },
        async rollback() { this.rolledBack = true }
      }
    }
  }
}

function makeEnvelope(orders, extra = {}) {
  return {
    type: 'commerce.orders.scraped',
    payload: {
      accountId: 9,
      adapterId: 'xiaohongshu.qianfan',
      capturedAt: '2026-10-13T10:44:00+08:00',
      orders,
      ...extra
    }
  }
}

function makeRow(overrides = {}) {
  return {
    订单号: 'P806378637922055401',
    状态: '已签收',
    用户名: '话痨仙人',
    用户ID: '60b36f99000000000100bb43',
    手机号: '186***8093',
    商家名称: '孤勇者玻璃隔热涂层的店',
    发货仓: '第三方平台卖家电子库存',
    收货地址: '福建省厦门市…',
    运单号: '772082096772059',
    创建时间: '2026/10/01 11:50:38',
    操作列表: ['备注', '联系买家'],
    ...overrides
  }
}

test('parseChinaTime 支持斜杠格式并归一到 MySQL DATETIME', () => {
  assert.equal(parseChinaTime('2026/10/01 11:50:38'), '2026-10-01 11:50:38')
  assert.equal(parseChinaTime('2026/1/9 8:05:07'), '2026-01-09 08:05:07')
  assert.equal(parseChinaTime('2026-10-01 11:50:38'), '2026-10-01 11:50:38')
  assert.equal(parseChinaTime(''), null)
  assert.equal(parseChinaTime('2026/10/01'), null)
})

test('STATUS_MAP 的取值全部落在平台订单状态词表内', () => {
  for (const [from, to] of Object.entries(STATUS_MAP)) {
    assert.ok(ORDER_STATUS.has(to), `${from} → ${to} 不在 ORDER_STATUS 中`)
  }
})

test('mapOrderRow 字段映射：状态/客户字段/时间，原文进 raw_payload', () => {
  const warnings = { unknownStatus: new Set() }
  const record = mapOrderRow(makeRow(), { adapterId: 'xiaohongshu.qianfan', capturedAt: 'T' }, warnings)

  assert.equal(record.orderNo, 'P806378637922055401')
  assert.equal(record.status, 'delivered')          // 已签收 → delivered
  assert.equal(record.statusRaw, '已签收')
  assert.equal(record.paymentStatus, 'paid')
  assert.equal(record.customerName, '话痨仙人')
  assert.equal(record.customerPhone, '186***8093')
  assert.equal(record.channelUserId, '60b36f99000000000100bb43')
  assert.equal(record.purchaseTime, '2026-10-01 11:50:38')
  // 列表页独有的列保留在 raw_payload（商家名称/发货仓/运单号）
  assert.equal(record.rawPayload.row['运单号'], '772082096772059')
  assert.equal(record.rawPayload.adapterId, 'xiaohongshu.qianfan')
  assert.equal(warnings.unknownStatus.size, 0)
})

test('mapOrderRow 已知状态全覆盖，未知状态回落 confirmed 并记警告', () => {
  const warnings = { unknownStatus: new Set() }
  assert.equal(mapOrderRow(makeRow({ 状态: '已完成' }), {}, warnings).status, 'closed')
  assert.equal(mapOrderRow(makeRow({ 状态: '取消发货' }), {}, warnings).status, 'cancelled')
  assert.equal(mapOrderRow(makeRow({ 状态: '已关闭' }), {}, warnings).status, 'closed')

  const unknown = mapOrderRow(makeRow({ 状态: '一个新状态' }), {}, warnings)
  assert.equal(unknown.status, 'confirmed')
  assert.equal(unknown.statusRaw, '一个新状态')
  assert.deepEqual([...warnings.unknownStatus], ['一个新状态'])
})

test('mapOrderRow 缺订单号或超长返回 null（跳过而不是造脏数据）', () => {
  const warnings = { unknownStatus: new Set() }
  assert.equal(mapOrderRow(makeRow({ 订单号: '' }), {}, warnings), null)
  assert.equal(mapOrderRow(makeRow({ 订单号: 'X'.repeat(41) }), {}, warnings), null)
})

test('handle 拒绝未登记的适配器', async () => {
  const service = createScrapedOrderIngestService({ sequelize: createFakeSequelize() })
  const result = await service.handle({ nodeId: 11,
    envelope: { payload: { adapterId: 'unknown.adapter', orders: [makeRow()] } }
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.errorCode, 'UNSUPPORTED_ADAPTER')
})

test('handle 空订单返回 processed 不报错', async () => {
  const service = createScrapedOrderIngestService({ sequelize: createFakeSequelize() })
  const result = await service.handle({ nodeId: 11, envelope: makeEnvelope([]) })
  assert.equal(result.status, 'processed')
})

test('handle 单批超限拒绝', async () => {
  const service = createScrapedOrderIngestService({ sequelize: createFakeSequelize() })
  const orders = Array.from({ length: 501 }, (_, i) => makeRow({ 订单号: `P${i}` }))
  const result = await service.handle({ nodeId: 11, envelope: makeEnvelope(orders) })
  assert.equal(result.status, 'rejected')
  assert.equal(result.errorCode, 'BATCH_TOO_LARGE')
})

test('handle 按订单号区分新增与更新，并使用 ON DUPLICATE KEY UPDATE 幂等写入', async () => {
  const sequelize = createFakeSequelize({
    existingOrderNos: ['P-OLD'],
    accountRow: { id: 9 }
  })
  const service = createScrapedOrderIngestService({ sequelize })
  const result = await service.handle({ nodeId: 11,
    envelope: makeEnvelope([
      makeRow({ 订单号: 'P-NEW' }),
      makeRow({ 订单号: 'P-OLD', 状态: '已关闭' })
    ])
  })

  assert.equal(result.status, 'processed')
  assert.match(result.message, /新增 1 条、更新 1 条/)

  const upserts = sequelize.calls.filter(call => /INSERT INTO orders/i.test(call.sql))
  assert.equal(upserts.length, 2)
  for (const call of upserts) {
    assert.match(call.sql, /ON DUPLICATE KEY UPDATE/)
    assert.equal(call.hasTransaction, true)
    assert.ok(call.replacements.orderNo)
    assert.equal(call.replacements.channel, 'xiaohongshu')
    assert.equal(call.replacements.accountId, 9)
  }

  // 只有新增的那条写事件轨迹；更新不重复写
  const events = sequelize.calls.filter(call => /INSERT INTO order_events/i.test(call.sql))
  assert.equal(events.length, 1)
  assert.equal(events[0].replacements.orderNo, 'P-NEW')

  // 账号解析走 desktop_bridge 账号
  const accountLookup = sequelize.calls.find(call => /FROM channel_accounts/i.test(call.sql))
  assert.match(accountLookup.sql, /desktop_bridge/)
})

test('handle 缺订单号的行被跳过并如实计数', async () => {
  const service = createScrapedOrderIngestService({ sequelize: createFakeSequelize() })
  const result = await service.handle({ nodeId: 11,
    envelope: makeEnvelope([makeRow({ 订单号: '' }), makeRow({ 订单号: 'P-OK' })])
  })
  assert.equal(result.status, 'processed')
  assert.match(result.message, /新增 1 条、更新 0 条，跳过 1/)
})

test('handle 数据库异常回滚并返回可重试状态', async () => {
  const sequelize = createFakeSequelize()
  sequelize.query = async () => { throw new Error('mysql down') }
  const service = createScrapedOrderIngestService({ sequelize })
  const result = await service.handle({ nodeId: 11, envelope: makeEnvelope([makeRow()]) })
  assert.equal(result.status, 'retryable_error')
  assert.equal(result.errorCode, 'ORDER_INGEST_FAILED')
})

test('适配器映射表覆盖路由层预期的 adapterId', () => {
  assert.equal(ADAPTER_CHANNEL_MAP['xiaohongshu.qianfan'], 'xiaohongshu')
})

test('订单上报必须携带显式账号和已认证节点', async () => {
  const sequelize = createFakeSequelize()
  const service = createScrapedOrderIngestService({ sequelize })
  assert.equal((await service.handle({ envelope: makeEnvelope([makeRow()]) })).errorCode, 'ACCOUNT_CONTEXT_REQUIRED')
  assert.equal((await service.handle({ nodeId: 11, envelope: makeEnvelope([makeRow()], { accountId: undefined }) })).errorCode, 'ACCOUNT_CONTEXT_REQUIRED')
  assert.equal(sequelize.calls.length, 0)
})

test('未绑定的账号不得写订单，查询同时限定节点和有效租约', async () => {
  const sequelize = createFakeSequelize({ accountRow: null })
  const result = await createScrapedOrderIngestService({ sequelize }).handle({ nodeId: 11, envelope: makeEnvelope([makeRow()]) })
  assert.equal(result.errorCode, 'ACCOUNT_NOT_BOUND')
  assert.equal(sequelize.calls.some(c => /INSERT/i.test(c.sql)), false)
  assert.equal(sequelize.calls[0].replacements.accountId, 9)
  assert.equal(sequelize.calls[0].replacements.nodeId, 11)
  assert.match(sequelize.calls[0].sql, /l.node_id = :nodeId AND l.expires_at > NOW/)
})

test('相同订单号属于其他渠道或其他店铺时拒绝整个批次', async () => {
  for (const existingOwner of [{ channel: 'douyin', account_id: 9 }, { channel: 'xiaohongshu', account_id: 88 }]) {
    const sequelize = createFakeSequelize({ existingOrderNos: ['P-CONFLICT'], existingOwner })
    const result = await createScrapedOrderIngestService({ sequelize }).handle({ nodeId: 11, envelope: makeEnvelope([makeRow({ 订单号: 'P-CONFLICT' })]) })
    assert.equal(result.errorCode, 'ORDER_OWNER_CONFLICT')
    assert.equal(sequelize.calls.some(c => /INSERT/i.test(c.sql)), false)
  }
})

test('事务创建失败返回可重试结果', async () => {
  const sequelize = createFakeSequelize()
  sequelize.transaction = async () => { throw new Error('connection unavailable') }
  assert.equal((await createScrapedOrderIngestService({ sequelize, logger: { error() {} } }).handle({ nodeId: 11, envelope: makeEnvelope([makeRow()]) })).status, 'retryable_error')
})
