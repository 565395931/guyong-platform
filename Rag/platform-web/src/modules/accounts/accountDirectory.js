import {
  DESKTOP_BRIDGE_CHANNELS,
  normalizePlatformChannel
} from '../platformMessages/platformFilters.js'

export function getAccountConnectionMode(channel) {
  return DESKTOP_BRIDGE_CHANNELS.includes(normalizePlatformChannel(channel))
    ? 'desktop_bridge_required'
    : 'official_api'
}

export function connectionModeLabel(channelOrMode) {
  const mode = channelOrMode === 'official_api' || channelOrMode === 'desktop_bridge_required'
    ? channelOrMode
    : getAccountConnectionMode(channelOrMode)
  return mode === 'desktop_bridge_required' ? '桌面节点' : '官方 API'
}

export function normalizeAccountRows(rows = []) {
  if (!Array.isArray(rows)) return []
  return rows.map(row => ({
    ...row,
    name: row.name || row.account_name || `账号 ${row.id}`,
    connectionMode: getAccountConnectionMode(row.channel),
    desktopNodeId: row.desktop_node_id || row.desktopNodeId || null
  }))
}

export function filterAccountRows(rows = [], channel = '') {
  const normalizedChannel = normalizePlatformChannel(channel)
  if (!normalizedChannel) return [...rows]
  return rows.filter(row => normalizePlatformChannel(row.channel) === normalizedChannel)
}
