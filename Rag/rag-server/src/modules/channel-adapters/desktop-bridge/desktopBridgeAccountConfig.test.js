const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DESKTOP_BRIDGE_ADAPTER_TYPE,
  DESKTOP_BRIDGE_ADAPTER_ID,
  CHANNEL_ADAPTER_IDS,
  expectedAdapterIdForChannel,
  hasCompleteDesktopBridgeAccountConfig,
  normalizeDesktopBridgeAccountConfig,
  parseDesktopBridgeAccountConfig,
  prepareDesktopBridgeAccountCreation,
  validateDesktopBridgeAccountConfig
} = require('./desktopBridgeAccountConfig')
const { encrypt } = require('../../../shared/utils/encrypt')

test('normalize 去空白并强制默认 adapterId', () => {
  const normalized = normalizeDesktopBridgeAccountConfig({
    shopName: '  孤勇者隔热材料  ',
    machineFingerprint: '  abc123  '
  })
  assert.equal(normalized.shopName, '孤勇者隔热材料')
  assert.equal(normalized.machineFingerprint, 'abc123')
  assert.equal(normalized.adapterId, DESKTOP_BRIDGE_ADAPTER_ID)
})

test('normalize 将窗口句柄转为正整数，非法值置空', () => {
  assert.equal(normalizeDesktopBridgeAccountConfig({ windowHandle: '1444098' }).windowHandle, 1444098)
  assert.equal(normalizeDesktopBridgeAccountConfig({ windowHandle: 0 }).windowHandle, null)
  assert.equal(normalizeDesktopBridgeAccountConfig({ windowHandle: -5 }).windowHandle, null)
  assert.equal(normalizeDesktopBridgeAccountConfig({ windowHandle: 'abc' }).windowHandle, null)
})

test('non-object 配置回落为空配置而不是抛错', () => {
  for (const bad of [null, undefined, 'text', 42, []]) {
    const normalized = normalizeDesktopBridgeAccountConfig(bad)
    assert.equal(normalized.shopName, '')
    assert.equal(normalized.machineFingerprint, '')
  }
})

test('validate 缺字段抛出带 code 与 fields 的错误', () => {
  assert.throws(
    () => validateDesktopBridgeAccountConfig({}),
    error => {
      assert.equal(error.code, 'DESKTOP_BRIDGE_ACCOUNT_CONFIG_INVALID')
      assert.deepEqual(error.fields, ['shopName', 'machineFingerprint'])
      return true
    }
  )
})

test('validate 只有店铺名时仍报出缺失的机器指纹', () => {
  assert.throws(
    () => validateDesktopBridgeAccountConfig({ shopName: '某店' }),
    error => {
      assert.deepEqual(error.fields, ['machineFingerprint'])
      return true
    }
  )
})

test('空白字符串不算有效值', () => {
  assert.equal(hasCompleteDesktopBridgeAccountConfig({ shopName: '   ', machineFingerprint: 'x' }), false)
  assert.equal(hasCompleteDesktopBridgeAccountConfig({ shopName: 'x', machineFingerprint: 'y' }), true)
})

test('prepare 强制 adapterType 并回传 adapterId 供绑定表使用', () => {
  const prepared = prepareDesktopBridgeAccountCreation({
    // 故意传入错误的 adapter_type，应被覆盖
    adapter_type: 'waha',
    config: { shopName: '某店', machineFingerprint: 'fp-1' }
  })
  assert.equal(prepared.adapterType, DESKTOP_BRIDGE_ADAPTER_TYPE)
  assert.equal(prepared.adapterId, DESKTOP_BRIDGE_ADAPTER_ID)
  assert.equal(prepared.config.shopName, '某店')
})

test('prepare 接受自定义 adapterId（为将来其它平台预留）', () => {
  const prepared = prepareDesktopBridgeAccountCreation({
    config: { shopName: '某店', machineFingerprint: 'fp-1', adapterId: 'pinduoduo.mobile' }
  })
  assert.equal(prepared.adapterId, 'pinduoduo.mobile')
})

test('prepare 按渠道决定 adapterId（douyin / xiaohongshu）', () => {
  const douyin = prepareDesktopBridgeAccountCreation({
    channel: 'douyin',
    config: { shopName: '某店', machineFingerprint: 'fp-1' }
  })
  assert.equal(douyin.adapterId, 'doudian.feige')
  assert.equal(douyin.config.adapterId, 'doudian.feige')

  const xhs = prepareDesktopBridgeAccountCreation({
    channel: 'xiaohongshu',
    config: { shopName: '某店', machineFingerprint: 'fp-1' }
  })
  assert.equal(xhs.adapterId, 'xiaohongshu.qianfan')
  assert.equal(xhs.config.adapterId, 'xiaohongshu.qianfan')
})

test('prepare 按渠道覆盖 config 里携带的错渠道 adapterId', () => {
  const prepared = prepareDesktopBridgeAccountCreation({
    channel: 'xiaohongshu',
    // 检测结果里若带了飞鸽的 adapterId，不允许串到小红书账号上
    config: { shopName: '某店', machineFingerprint: 'fp-1', adapterId: 'doudian.feige' }
  })
  assert.equal(prepared.adapterId, 'xiaohongshu.qianfan')
  assert.equal(prepared.config.adapterId, 'xiaohongshu.qianfan')
})

test('expectedAdapterIdForChannel 未知渠道返回空串（保持旧回落行为）', () => {
  assert.equal(expectedAdapterIdForChannel('douyin'), 'doudian.feige')
  assert.equal(expectedAdapterIdForChannel('XiaoHongShu'), 'xiaohongshu.qianfan')
  assert.equal(expectedAdapterIdForChannel('pinduoduo'), 'pinduoduo.workbench')
  assert.equal(expectedAdapterIdForChannel('kuaishou'), '')
  assert.equal(expectedAdapterIdForChannel(''), '')
  assert.equal(expectedAdapterIdForChannel(undefined), '')
})

test('parse 能往返加密后的持久化形态', () => {
  const original = { shopName: '孤勇者隔热材料', machineFingerprint: 'fp-roundtrip', windowHandle: 9114592 }
  const parsed = parseDesktopBridgeAccountConfig(encrypt(original))
  assert.equal(parsed.shopName, original.shopName)
  assert.equal(parsed.machineFingerprint, original.machineFingerprint)
  assert.equal(parsed.windowHandle, original.windowHandle)
})

test('parse 对无法解密的输入回落为空配置而不抛错', () => {
  const parsed = parseDesktopBridgeAccountConfig('not-encrypted-not-json')
  assert.equal(parsed.shopName, '')
  assert.equal(parsed.machineFingerprint, '')
})

test('配置里不残留任何凭据字段', () => {
  const normalized = normalizeDesktopBridgeAccountConfig({
    shopName: '某店',
    machineFingerprint: 'fp-1',
    appKey: 'should-not-persist',
    appSecret: 'should-not-persist',
    accessToken: 'should-not-persist'
  })
  const serialized = JSON.stringify(normalized)
  assert.equal(serialized.includes('appKey'), false)
  assert.equal(serialized.includes('should-not-persist'), false)
})
