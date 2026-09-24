const CHANNEL_LABELS = Object.freeze({
  wecom_kf: '微信客服',
  wechat: '微信小程序',
  whatsapp: 'WhatsApp',
  douyin: '抖店',
  pinduoduo: '拼多多',
  taobao: '淘宝 / 千牛',
  alibaba1688: '1688'
})

export function resolveChannelScope(value) {
  const input = value && typeof value === 'object'
    ? value
    : { meta: value }
  const first = candidate => Array.isArray(candidate) ? candidate[0] : candidate
  const selected = first(input.prop) || first(input.query) || first(input.meta) || ''
  const fixedChannel = String(selected).trim().toLowerCase()
  if (!CHANNEL_LABELS[fixedChannel]) {
    return {
      fixedChannel: '',
      selectedChannels: [],
      label: '全部渠道',
      filterLocked: false
    }
  }

  return {
    fixedChannel,
    selectedChannels: [fixedChannel],
    label: CHANNEL_LABELS[fixedChannel],
    filterLocked: true
  }
}
