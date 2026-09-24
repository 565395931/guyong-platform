export function resolveChannelChrome(value) {
  const channelCode = String(value || '').trim().toLowerCase()
  return {
    channelCode,
    showWahaStatus: channelCode !== 'wecom_kf'
  }
}
