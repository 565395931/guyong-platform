import { ref } from 'vue'
import { getChannelsStatus } from '@/api/channels'

/**
 * 渠道连接状态的**共享**来源。
 *
 * 顶栏的「渠道正常」指示器、左侧渠道菜单的红光、客服账号管理的红光都要用同一份状态，
 * 各查各的会变成三个轮询。这里用模块级单例 + 订阅计数：第一个订阅者开始轮询，
 * 最后一个退订时停掉。
 *
 * 判定口径与后端一致（routes/channelStatus.js）：
 *   HEALTHY / CONNECTED / ACTIVE → 正常
 *   OFFLINE / CRITICAL / UNKNOWN / PARTIAL → 需要提醒（未知也提醒：宁可让人点开看一眼）
 */

const REFRESH_MS = 60000

const channels = ref([])
const remoteShopAccounts = ref([])
const overall = ref('UNKNOWN')
const loaded = ref(false)
const loading = ref(false)

let timer = null
let subscribers = 0
let inflight = null

const ABNORMAL_STATUSES = new Set(['OFFLINE', 'CRITICAL', 'UNKNOWN', 'PARTIAL'])

async function fetchChannelHealth() {
  if (inflight) return inflight
  loading.value = true
  inflight = (async () => {
    try {
      const res = await getChannelsStatus()
      const data = res?.data || {}
      channels.value = Array.isArray(data.channels) ? data.channels : []
      remoteShopAccounts.value = Array.isArray(data.remoteShopAccounts) ? data.remoteShopAccounts : []
      overall.value = data.overall || 'UNKNOWN'
      loaded.value = true
    } catch (err) {
      console.error('[ChannelHealth] 获取渠道状态失败:', err)
      // 查不到就当作"未知"，让界面提示而不是假装正常
      overall.value = 'UNKNOWN'
    } finally {
      loading.value = false
      inflight = null
    }
  })()
  return inflight
}

function startPolling() {
  subscribers += 1
  // 每次挂载都拉一次：第二个组件挂载时定时器已经在了，早退的话它会一直显示
  // 上一次的结果（最多 60 秒的陈旧状态）——渠道掉线提示不能这么迟钝。
  // 重复请求由 inflight 去重。
  fetchChannelHealth()
  if (timer) return
  timer = setInterval(fetchChannelHealth, REFRESH_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

function stopPolling() {
  subscribers = Math.max(0, subscribers - 1)
  if (subscribers === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 某渠道是否异常（没配这个渠道时返回 false，不误报）。 */
function isChannelAbnormal(channel) {
  if (!channel) return false
  const row = channels.value.find(item => item.channel === channel)
  if (!row) return false
  return ABNORMAL_STATUSES.has(String(row.status || '').toUpperCase())
}

/** 某渠道的状态文案，供提示用。 */
function channelStatusText(channel) {
  const row = channels.value.find(item => item.channel === channel)
  if (!row) return ''
  return ({
    CONNECTED: '连接正常',
    ACTIVE: '正常',
    PARTIAL: '部分会话异常',
    OFFLINE: '连不上',
    UNKNOWN: '状态未知'
  })[String(row.status || '').toUpperCase()] || row.status
}

/** 组件里用：自动开始/停止轮询。 */
export function useChannelHealth() {
  return {
    channels,
    remoteShopAccounts,
    overall,
    loaded,
    loading,
    isChannelAbnormal,
    channelStatusText,
    refresh: fetchChannelHealth,
    startPolling,
    stopPolling
  }
}

/** 测试用：重置模块级状态。 */
export function __resetChannelHealth() {
  if (timer) clearInterval(timer)
  timer = null
  subscribers = 0
  inflight = null
  channels.value = []
  remoteShopAccounts.value = []
  overall.value = 'UNKNOWN'
  loaded.value = false
}

export { ABNORMAL_STATUSES }
