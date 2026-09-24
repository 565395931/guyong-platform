const { isDeepStrictEqual } = require('util')

function configurationError(message, code = 'invalid_runtime_config') {
  const error = new Error(message)
  error.code = code
  return error
}

function requiredText(value, field) {
  const text = String(value || '').trim()
  if (!text) throw configurationError(`${field} is required`)
  return text
}

function positiveInteger(value, field) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw configurationError(`${field} is invalid`)
  return number
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw configurationError('runtime snapshot must be an object')
  }
  const encodingAesKey = requiredText(snapshot.encodingAesKey, 'encodingAesKey')
  if (encodingAesKey.length !== 43 || Buffer.from(`${encodingAesKey}=`, 'base64').length !== 32) {
    throw configurationError('encodingAesKey is invalid')
  }
  if (!Array.isArray(snapshot.accounts)) throw configurationError('accounts must be an array')
  const seenAccountIds = new Set()
  const seenOpenKfIds = new Set()
  const accounts = snapshot.accounts.map(account => {
    const accountId = positiveInteger(account?.accountId, 'accountId')
    const openKfId = requiredText(account?.openKfId, 'openKfId')
    if (seenAccountIds.has(accountId) || seenOpenKfIds.has(openKfId)) {
      throw configurationError('runtime snapshot contains duplicate account mappings')
    }
    seenAccountIds.add(accountId)
    seenOpenKfIds.add(openKfId)
    return { ...account, accountId, openKfId }
  })
  return {
    ...snapshot,
    connectionId: positiveInteger(snapshot.connectionId, 'connectionId'),
    configVersion: positiveInteger(snapshot.configVersion, 'configVersion'),
    callbackKey: requiredText(snapshot.callbackKey, 'callbackKey'),
    corpId: requiredText(snapshot.corpId, 'corpId'),
    secret: requiredText(snapshot.secret, 'secret'),
    callbackToken: requiredText(snapshot.callbackToken, 'callbackToken'),
    encodingAesKey,
    accounts
  }
}

function createRuntimeConfigService({ store, cipher, now = () => new Date() }) {
  if (!store || !cipher) throw new Error('runtime config store and cipher are required')

  async function decryptRecord(record) {
    if (!record) return null
    const snapshot = normalizeSnapshot(cipher.decrypt(record.ciphertext))
    if (snapshot.connectionId !== Number(record.connectionId) || snapshot.configVersion !== Number(record.configVersion)) {
      throw configurationError('runtime snapshot metadata does not match encrypted record')
    }
    return { ...snapshot, runtimeStatus: record.status }
  }

  return {
    async apply(input) {
      const connectionId = positiveInteger(input?.connectionId, 'connectionId')
      const configVersion = positiveInteger(input?.configVersion, 'configVersion')
      const status = String(input?.status || '')
      if (!['active', 'disabled'].includes(status)) throw configurationError('status is invalid')
      const ciphertext = requiredText(input?.ciphertext, 'ciphertext')
      const snapshot = normalizeSnapshot(cipher.decrypt(ciphertext))
      if (snapshot.connectionId !== connectionId || snapshot.configVersion !== configVersion) {
        throw configurationError('runtime snapshot metadata does not match apply request')
      }
      const existing = await store.get(connectionId)
      if (existing && Number(existing.configVersion) > configVersion) {
        throw configurationError('runtime config version is stale', 'stale_config_version')
      }
      if (existing && Number(existing.configVersion) === configVersion) {
        if (existing.status !== status || existing.ciphertext !== ciphertext) {
          throw configurationError('runtime config version already exists with different content', 'config_version_conflict')
        }
        return { connectionId, configVersion, status: 'applied', duplicate: true }
      }
      await store.put({
        connectionId,
        configVersion,
        status,
        ciphertext,
        updatedAt: now().toISOString()
      })
      return { connectionId, configVersion, status: 'applied', duplicate: false }
    },

    async getActiveByConnectionId(connectionId) {
      const record = await store.get(connectionId)
      if (!record || record.status !== 'active') return null
      return decryptRecord(record)
    },

    async getActiveByCallbackKey(callbackKey) {
      const expected = String(callbackKey || '')
      for (const record of await store.list()) {
        if (record.status !== 'active') continue
        const snapshot = await decryptRecord(record)
        if (snapshot.callbackKey === expected) return snapshot
      }
      return null
    },

    async getActiveByAccountId(accountId) {
      const expected = Number(accountId)
      if (!Number.isInteger(expected) || expected <= 0) return null
      for (const record of await store.list()) {
        if (record.status !== 'active') continue
        const snapshot = await decryptRecord(record)
        const account = snapshot.accounts.find(item => Number(item.accountId) === expected)
        if (account) return { runtimeConfig: snapshot, account }
      }
      return null
    },

    normalizeSnapshot,
    isEquivalent(left, right) {
      return isDeepStrictEqual(normalizeSnapshot(left), normalizeSnapshot(right))
    }
  }
}

module.exports = { createRuntimeConfigService, normalizeSnapshot }
