const { createCallbackCrypto } = require('./callbackCrypto')
const { normalizeWecomMessage } = require('./messageNormalizer')
const { parseCallbackNotification, parseEncryptedEnvelope } = require('./xmlEnvelope')

function adapterError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function callbackQuery(query = {}) {
  return {
    signature: query.msg_signature || query.msgSignature,
    timestamp: query.timestamp,
    nonce: query.nonce
  }
}

function createWecomAdapter({
  runtimeConfigService,
  apiClient,
  syncStateStore,
  ingestInbound,
  maxPages = 100
}) {
  if (!runtimeConfigService || !apiClient || !syncStateStore || !ingestInbound) {
    throw new Error('WeCom adapter dependencies are required')
  }
  const syncLocks = new Map()

  async function requireRuntimeConfig(callbackKey) {
    const config = await runtimeConfigService.getActiveByCallbackKey(callbackKey)
    if (!config) throw adapterError('WeCom callback connection was not found', 'wecom_callback_not_found')
    return config
  }

  function cryptoFor(config) {
    return createCallbackCrypto({
      token: config.callbackToken,
      encodingAesKey: config.encodingAesKey,
      receiveId: config.corpId
    })
  }

  async function processNotification(config, notification) {
    if (syncLocks.has(config.connectionId)) return syncLocks.get(config.connectionId)
    const processing = (async () => {
      const state = await syncStateStore.get(config.connectionId)
      let cursor = String(state?.cursor || '')
      try {
        for (let page = 0; page < maxPages; page += 1) {
          const result = await apiClient.syncMessages(config, {
            token: notification.token,
            cursor,
            openKfId: notification.openKfId || undefined
          })
          for (const message of result.messages) {
            const normalized = normalizeWecomMessage(message, config)
            if (normalized) await ingestInbound(normalized.payload, normalized.eventId)
          }
          const nextCursor = String(result.nextCursor || cursor)
          if (!result.hasMore) {
            cursor = nextCursor
            await syncStateStore.markSuccess(config.connectionId, { cursor })
            return { cursor, pages: page + 1 }
          }
          if (!nextCursor || nextCursor === cursor) {
            throw adapterError('WeCom sync cursor did not advance', 'wecom_sync_cursor_stalled')
          }
          cursor = nextCursor
        }
        throw adapterError('WeCom sync exceeded the page limit', 'wecom_sync_page_limit')
      } catch (error) {
        await syncStateStore.markFailure(config.connectionId, error)
        throw error
      }
    })()
    syncLocks.set(config.connectionId, processing)
    processing.finally(() => {
      if (syncLocks.get(config.connectionId) === processing) syncLocks.delete(config.connectionId)
    }).catch(() => {})
    return processing
  }

  return {
    async verifyCallback({ callbackKey, query = {} }) {
      const config = await requireRuntimeConfig(callbackKey)
      const encrypted = String(query.echostr || '')
      if (!encrypted) throw adapterError('WeCom verification echo is required', 'wecom_echo_required')
      return cryptoFor(config).decrypt({
        ...callbackQuery(query),
        encrypted
      })
    },

    async handleCallback({ callbackKey, query = {}, body }) {
      const config = await requireRuntimeConfig(callbackKey)
      const { encrypted } = parseEncryptedEnvelope(body)
      const decrypted = cryptoFor(config).decrypt({
        ...callbackQuery(query),
        encrypted
      })
      const notification = parseCallbackNotification(decrypted)
      if (notification.event !== 'kf_msg_or_event') {
        throw adapterError('Unsupported WeCom callback event', 'wecom_callback_event_unsupported')
      }
      return {
        status: 200,
        body: 'success',
        processing: processNotification(config, notification)
      }
    }
  }
}

module.exports = { createWecomAdapter }

