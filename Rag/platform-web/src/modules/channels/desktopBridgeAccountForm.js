/**
 * 桌面桥接接入方式的表单模型。
 *
 * 与官方 API 接入的区别：账号凭据不是 App Key，而是**本机客户端检测结果**
 * （店铺名 + 机器指纹）。因此提交时带 `connection_mode: 'desktop_bridge'`，
 * 后端据此走 `prepareDesktopBridgeAccountCreation` 并在同事务内写入
 * `desktop_bridge_bindings`（缺绑定则租约永远无法获取）。
 */

const cleanText = value => typeof value === 'string' ? value.trim() : ''

const cleanInteger = value => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null
}

export const DESKTOP_BRIDGE_CONNECTION_MODE = 'desktop_bridge'
export const DESKTOP_BRIDGE_ADAPTER_TYPE = 'desktop_bridge'
export const DEFAULT_DESKTOP_BRIDGE_ADAPTER_ID = 'doudian.feige'

/**
 * 目前**本机探针能真正检测到**的渠道。
 * 注意与 platformFilters.DESKTOP_BRIDGE_CHANNELS 区分：后者是"长期需要桌面桥接的平台"
 * （7 个），这里只列已经实现检测适配器的。给未实现的渠道露出选项会误导用户。
 */
export const DESKTOP_BRIDGE_DETECTABLE_CHANNELS = Object.freeze(['douyin'])

/**
 * 已经打通**出站发送**（服务端指令队列 -> 本机节点 -> 写入客户端）的渠道。
 * 只有抖音有可用的节点实现；其余渠道的适配器仍硬编码返回 bridge_required，
 * 所以它们的会话必须继续标只读，否则用户点了发送只会得到一个失败。
 */
export const DESKTOP_BRIDGE_SENDABLE_CHANNELS = Object.freeze(['douyin'])
export const DESKTOP_BRIDGE_REQUIRED_FIELDS = Object.freeze([
  { name: 'shopName', label: '店铺名称' },
  { name: 'machineFingerprint', label: '机器指纹' }
])

export function normalizeDetection(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    shopName: cleanText(source.shopName),
    machineFingerprint: cleanText(source.machineFingerprint),
    adapterId: cleanText(source.adapterId) || DEFAULT_DESKTOP_BRIDGE_ADAPTER_ID,
    hostName: cleanText(source.hostName),
    agentStatus: cleanText(source.agentStatus),
    clientProcess: cleanText(source.clientProcess),
    detectedAt: cleanText(source.detectedAt),
    windowHandle: cleanInteger(source.windowHandle),
    renderHostHandle: cleanInteger(source.renderHostHandle)
  }
}

export function createDesktopBridgeAccountForm({ channel, adapterId = DEFAULT_DESKTOP_BRIDGE_ADAPTER_ID }) {
  function normalize(input = {}) {
    const parsedQuota = Number(input.maxDailyQuota ?? input.max_daily_quota ?? 1000)
    return {
      accountName: cleanText(input.accountName ?? input.account_name),
      detection: normalizeDetection(input.detection),
      maxDailyQuota: Number.isFinite(parsedQuota) && parsedQuota > 0 ? parsedQuota : 1000
    }
  }

  function validate(input = {}) {
    const form = normalize(input)
    const errors = []
    if (!form.accountName) errors.push('账号名称不能为空')
    if (!form.detection.shopName) errors.push('请先自动检测本地客户端')
    for (const field of DESKTOP_BRIDGE_REQUIRED_FIELDS) {
      if (!form.detection[field.name]) errors.push(`${field.label} 缺失，请重新检测`)
    }
    return errors
  }

  function buildRequest(input = {}) {
    const form = normalize(input)
    return {
      channel,
      account_name: form.accountName,
      adapter_type: DESKTOP_BRIDGE_ADAPTER_TYPE,
      connection_mode: DESKTOP_BRIDGE_CONNECTION_MODE,
      max_daily_quota: form.maxDailyQuota,
      config: {
        ...form.detection,
        adapterId: form.detection.adapterId || adapterId
      }
    }
  }

  return { normalize, validate, buildRequest }
}
