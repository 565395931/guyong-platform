function createCustomerOperationsTimer({
  runPendingWork = async () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 60_000,
  logger = console
} = {}) {
  let handle = null
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      await runPendingWork()
    } catch (error) {
      logger.error?.('[CustomerOperationsTimer] pending work failed:', error.message)
    } finally {
      running = false
    }
  }

  function start() {
    if (handle) return handle
    handle = setIntervalFn(() => tick(), intervalMs)
    handle?.unref?.()
    return handle
  }

  function stop() {
    if (!handle) return
    clearIntervalFn(handle)
    handle = null
  }

  return { start, stop, tick }
}

module.exports = { createCustomerOperationsTimer }
