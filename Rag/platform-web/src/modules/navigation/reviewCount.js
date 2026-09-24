import { ref } from 'vue'

export function normalizeReviewCount(stats = {}) {
  const total = stats.all ?? (Number(stats.mine || 0) + Number(stats.public || 0))
  return Math.max(0, Number.isFinite(Number(total)) ? Number(total) : 0)
}

export function formatReviewCount(count) {
  return Number(count) > 99 ? '99+' : String(Math.max(0, Number(count) || 0))
}

export function createReviewCounter({
  fetchStats,
  websocket,
  setIntervalFn = window.setInterval.bind(window),
  clearIntervalFn = window.clearInterval.bind(window),
  intervalMs = 30000
}) {
  const count = ref(0)
  let timer
  let refreshing = Promise.resolve()

  const refresh = () => {
    refreshing = Promise.resolve(fetchStats())
      .then(response => { count.value = normalizeReviewCount(response?.data) })
      .catch(() => { count.value = 0 })
    return refreshing
  }
  const handleUpdated = () => refresh()

  const start = () => {
    refresh()
    timer = setIntervalFn(refresh, intervalMs)
    websocket.on('message_review_updated', handleUpdated)
  }

  const stop = () => {
    if (timer !== undefined) clearIntervalFn(timer)
    timer = undefined
    websocket.off('message_review_updated', handleUpdated)
  }

  return {
    count,
    refresh,
    start,
    stop,
    get refreshing() { return refreshing }
  }
}
