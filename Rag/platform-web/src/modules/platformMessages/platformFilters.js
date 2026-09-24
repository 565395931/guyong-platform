export const PLATFORM_OPTIONS = Object.freeze([
  { value: '', label: '全部' },
  { value: 'wecom_kf', label: '微信客服' },
  { value: 'wechat', label: '微信小程序' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'douyin', label: '抖店' },
  { value: 'pinduoduo', label: '拼多多' },
  { value: 'taobao', label: '淘宝 / 千牛' },
  { value: 'alibaba1688', label: '1688' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'wechat_shop', label: '微信小店' },
  { value: 'kuaishou', label: '快手小店' }
])

export const DESKTOP_BRIDGE_CHANNELS = Object.freeze([
  'douyin',
  'pinduoduo',
  'taobao',
  'alibaba1688',
  'xiaohongshu',
  'wechat_shop',
  'kuaishou'
])

const CHANNEL_ALIASES = Object.freeze({
  '1688': 'alibaba1688',
  qianniu: 'taobao',
  xhs: 'xiaohongshu',
  weixin_shop: 'wechat_shop',
  kuaishou_shop: 'kuaishou'
})

const SUPPORTED_CHANNELS = new Set(PLATFORM_OPTIONS.map(option => option.value))
const EVENT_CHANNELS = new Set(DESKTOP_BRIDGE_CHANNELS)

const first = value => Array.isArray(value) ? value[0] : value

export function normalizePlatformChannel(value) {
  const normalized = String(first(value) || '').trim().toLowerCase()
  const channel = CHANNEL_ALIASES[normalized] || normalized
  return SUPPORTED_CHANNELS.has(channel) ? channel : ''
}

export function normalizePlatformView(value) {
  return first(value) === 'events' ? 'events' : 'conversations'
}

export function normalizeMessageFilters({ channel, view } = {}) {
  const normalizedChannel = normalizePlatformChannel(channel)
  const normalizedView = normalizePlatformView(view)
  if (normalizedView !== 'events') {
    return { channel: normalizedChannel, view: 'conversations' }
  }
  if (!normalizedChannel) return { channel: 'douyin', view: 'events' }
  if (!EVENT_CHANNELS.has(normalizedChannel)) {
    return { channel: normalizedChannel, view: 'conversations' }
  }
  return { channel: normalizedChannel, view: 'events' }
}

export function normalizeChannelAccountOptions(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map(row => ({
    id: row.id,
    channel: normalizePlatformChannel(row.channel),
    name: row.account_name || row.accountName || row.name || `账号 ${row.id}`,
    status: row.status || 'unknown'
  }))
}

export function requiresDesktopBridge(channel) {
  return DESKTOP_BRIDGE_CHANNELS.includes(normalizePlatformChannel(channel))
}
