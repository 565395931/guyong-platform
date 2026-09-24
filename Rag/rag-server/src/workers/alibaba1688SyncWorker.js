const systemLogger = require('../utils/systemLogger')
const {
  parseAlibaba1688AccountConfig,
  validateAlibaba1688AccountConfig
} = require('../modules/channel-adapters/alibaba1688-commerce/alibaba1688AccountConfig')
const {
  createAlibaba1688SyncService
} = require('../modules/channel-adapters/alibaba1688-commerce/alibaba1688SyncService')
const { createChannelEventInboxRepository } = require('../modules/channel-events/channelEventInbox.repository')
const { createChannelSyncStateRepository } = require('../modules/channel-sync/channelSyncState.repository')

const DEFAULT_INTERVAL_MS = 60_000

function safeCode(error, fallback = 'ALIBABA1688_SYNC_FAILED') {
  const code = String(error?.code || '').trim()
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(code) ? code : fallback
}

function createAlibaba1688SyncWorker({
  sequelize,
  syncService,
  parseAccountConfig = parseAlibaba1688AccountConfig,
  validateAccountConfig = validateAlibaba1688AccountConfig,
  logger = systemLogger,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new TypeError('1688 worker sequelize dependency is required')
  }
  if (!syncService || typeof syncService.syncAccount !== 'function') {
    throw new TypeError('1688 worker sync service dependency is required')
  }
  if (typeof parseAccountConfig !== 'function' || typeof validateAccountConfig !== 'function') {
    throw new TypeError('1688 worker config dependencies are invalid')
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('1688 worker interval is invalid')
  }

  let running = false
  let timer = null

  function log(level, event, details = {}) {
    if (logger && typeof logger[level] === 'function') logger[level](event, details)
  }

  async function loadActiveAccounts() {
    const [rows] = await sequelize.query(
      `SELECT id, config
         FROM channel_accounts
        WHERE status = 'active'
          AND adapter_type = 'alibaba1688_commerce'
        ORDER BY id ASC`
    )
    return Array.isArray(rows) ? rows : []
  }

  async function tick() {
    if (running) return { skipped: true, reason: 'already_running' }
    running = true
    try {
      const accounts = await loadActiveAccounts()
      let succeeded = 0
      let failed = 0
      for (const row of accounts) {
        const accountId = Number(row.id)
        try {
          const credentials = validateAccountConfig(
            parseAccountConfig(row.config, `account:${accountId}`)
          )
          await syncService.syncAccount({ id: accountId, credentials })
          succeeded += 1
        } catch (error) {
          failed += 1
          log('error', 'alibaba1688.sync_account_failed', {
            accountId: Number.isSafeInteger(accountId) ? accountId : null,
            code: safeCode(error)
          })
        }
      }
      const result = { accounts: accounts.length, succeeded, failed }
      log('info', 'alibaba1688.sync_tick_completed', result)
      return result
    } catch (error) {
      log('error', 'alibaba1688.sync_tick_failed', { code: safeCode(error) })
      const safeError = new Error('1688 sync tick failed')
      safeError.code = 'ALIBABA1688_SYNC_TICK_FAILED'
      throw safeError
    } finally {
      running = false
    }
  }

  const worker = {
    tick,
    start() {
      if (timer) return worker
      timer = setIntervalFn(() => { void tick().catch(() => {}) }, intervalMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return worker
    },
    stop() {
      if (timer) clearIntervalFn(timer)
      timer = null
      return worker
    }
  }
  return worker
}

function initAlibaba1688SyncWorker({ sequelize, logger = systemLogger } = {}) {
  const eventInbox = createChannelEventInboxRepository(sequelize)
  const syncState = createChannelSyncStateRepository(sequelize)
  const syncService = createAlibaba1688SyncService({ eventInbox, syncState })
  return createAlibaba1688SyncWorker({ sequelize, syncService, logger }).start()
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  createAlibaba1688SyncWorker,
  initAlibaba1688SyncWorker
}
