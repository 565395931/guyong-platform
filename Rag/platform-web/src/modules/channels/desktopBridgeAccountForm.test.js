import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_DESKTOP_BRIDGE_ADAPTER_ID,
  DESKTOP_BRIDGE_CONNECTION_MODE,
  DESKTOP_BRIDGE_DETECTABLE_CHANNELS,
  createDesktopBridgeAccountForm,
  normalizeDetection
} from './desktopBridgeAccountForm.js'

const form = () => createDesktopBridgeAccountForm({ channel: 'douyin' })

const detection = {
  shopName: '孤勇者隔热材料',
  machineFingerprint: 'b05a3bdba9017d80c63959699c912e86',
  hostName: 'WIN-MF5QDS1OUD5',
  agentStatus: '小休',
  clientProcess: 'doudian.exe',
  windowHandle: 1444098,
  renderHostHandle: 9114592
}

test('提交时带 connection_mode，后端据此走桌面桥接分支', () => {
  const request = form().buildRequest({ accountName: '某店', detection })
  assert.equal(request.connection_mode, DESKTOP_BRIDGE_CONNECTION_MODE)
  assert.equal(request.adapter_type, 'desktop_bridge')
  assert.equal(request.channel, 'douyin')
  assert.equal(request.account_name, '某店')
})

test('config 只含检测信息，不含 App Key 类凭据', () => {
  const request = form().buildRequest({ accountName: '某店', detection })

  assert.equal(request.config.shopName, '孤勇者隔热材料')
  assert.equal(request.config.machineFingerprint, detection.machineFingerprint)
  assert.equal(request.config.adapterId, DEFAULT_DESKTOP_BRIDGE_ADAPTER_ID)

  const serialized = JSON.stringify(request.config)
  for (const forbidden of ['appKey', 'appSecret', 'accessToken', 'sessionKey']) {
    assert.equal(serialized.includes(forbidden), false, `config 不应包含 ${forbidden}`)
  }
})

test('未检测时校验失败并给出可读提示', () => {
  const errors = form().validate({ accountName: '某店', detection: null })
  assert.ok(errors.length > 0)
  assert.match(errors.join(' '), /自动检测/)
})

test('检测结果缺少店铺名或机器指纹时逐项报错', () => {
  const missingShop = form().validate({
    accountName: '某店',
    detection: { ...detection, shopName: '' }
  })
  assert.match(missingShop.join(' '), /店铺名称/)

  const missingFp = form().validate({
    accountName: '某店',
    detection: { ...detection, machineFingerprint: '  ' }
  })
  assert.match(missingFp.join(' '), /机器指纹/)
})

test('账号名称为空时报错', () => {
  const errors = form().validate({ accountName: '   ', detection })
  assert.match(errors.join(' '), /账号名称/)
})

test('检测信息完整时校验通过', () => {
  assert.deepEqual(form().validate({ accountName: '某店', detection }), [])
})

test('normalizeDetection 去空白并把句柄转为正整数', () => {
  const normalized = normalizeDetection({
    shopName: '  某店  ',
    machineFingerprint: '  fp  ',
    windowHandle: '1444098',
    renderHostHandle: 0
  })
  assert.equal(normalized.shopName, '某店')
  assert.equal(normalized.machineFingerprint, 'fp')
  assert.equal(normalized.windowHandle, 1444098)
  assert.equal(normalized.renderHostHandle, null)
  assert.equal(normalized.adapterId, DEFAULT_DESKTOP_BRIDGE_ADAPTER_ID)
})

test('normalizeDetection 对非对象输入回落为空检测', () => {
  for (const bad of [null, undefined, 'text', 42, []]) {
    const normalized = normalizeDetection(bad)
    assert.equal(normalized.shopName, '')
    assert.equal(normalized.machineFingerprint, '')
  }
})

test('每日上限非法时回落为 1000', () => {
  assert.equal(form().normalize({ accountName: 'x', detection, maxDailyQuota: 0 }).maxDailyQuota, 1000)
  assert.equal(form().normalize({ accountName: 'x', detection, maxDailyQuota: -3 }).maxDailyQuota, 1000)
  assert.equal(form().normalize({ accountName: 'x', detection, maxDailyQuota: 50 }).maxDailyQuota, 50)
})

test('只对已实现检测适配器的渠道露出桌面桥接选项', () => {
  // 与 platformFilters.DESKTOP_BRIDGE_CHANNELS（7 个长期目标）区分：
  // 这里只列真的能检测到的，避免给未实现的渠道露选项。
  assert.deepEqual([...DESKTOP_BRIDGE_DETECTABLE_CHANNELS], ['douyin'])
})
