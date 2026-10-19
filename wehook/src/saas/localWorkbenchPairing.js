const crypto = require('crypto')
const { hashToken, createOpaqueToken } = require('./security')

function fail(code) { throw Object.assign(new Error(code), { code }) }
function activeTenant(data, id) { return data.tenants.find(item => item.id === id && item.status === 'active') }
function publicClient(row) { const { tokenHash, ...safe } = row; return safe }

// Dedicated chat credentials: existing credit-device tokens cannot read conversations.
class LocalWorkbenchPairing {
  constructor({ store, now = Date.now }) { this.store = store; this.now = now }

  issue({ tenantId, installationIds = null, actorId }) {
    return this.store.transaction(data => {
      if (!activeTenant(data, tenantId)) fail('local_pairing_invalid_tenant')
      if (installationIds !== null && (!Array.isArray(installationIds) || !installationIds.length || installationIds.some(id => !data.shopInstallations.some(shop => shop.id === id && shop.tenantId === tenantId)))) fail('local_pairing_invalid_scope')
      const createdAt = new Date(this.now()).toISOString()
      const expiresAt = new Date(this.now() + 5 * 60 * 1000).toISOString()
      const code = createOpaqueToken('lwp')
      for (const row of data.localPairings) if (row.tenantId === tenantId && row.status === 'pending') row.status = 'revoked'
      const pairing = { id: crypto.randomUUID(), tenantId, installationIds: installationIds ? [...new Set(installationIds)] : null, codeHash: hashToken(code), status: 'pending', createdAt, expiresAt }
      data.localPairings.push(pairing)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'local.pairing_issue', targetType: 'local_pairing', targetId: pairing.id, createdAt })
      return { code, expiresAt, tenantId, installationIds: pairing.installationIds }
    })
  }

  exchange({ code, name }) {
    return this.store.transaction(data => {
      const pairing = data.localPairings.find(row => row.codeHash === hashToken(code) && row.status === 'pending' && Date.parse(row.expiresAt) > this.now())
      if (!pairing || !activeTenant(data, pairing.tenantId)) fail('local_pairing_rejected')
      const token = createOpaqueToken('lwl')
      const createdAt = new Date(this.now()).toISOString()
      const client = { id: crypto.randomUUID(), tenantId: pairing.tenantId, installationIds: pairing.installationIds, name: String(name || '本地工作台').trim().slice(0, 80), tokenHash: hashToken(token), status: 'active', scope: 'shop_bridge', createdAt }
      data.localClients.push(client)
      pairing.status = 'used'; pairing.clientId = client.id; pairing.usedAt = createdAt
      data.auditEntries.push({ id: crypto.randomUUID(), actorId: client.id, action: 'local.pairing_exchange', targetType: 'local_client', targetId: client.id, createdAt })
      return { client: publicClient(client), token }
    })
  }

  async authenticate(token) {
    if (!token) return null
    const data = await this.store.snapshot()
    const client = data.localClients.find(row => row.tokenHash === hashToken(token) && row.status === 'active' && row.scope === 'shop_bridge')
    return client && activeTenant(data, client.tenantId) ? publicClient(client) : null
  }

  async discovery(token) {
    const client = await this.authenticate(token)
    if (!client) fail('local_client_unauthorized')
    const data = await this.store.snapshot()
    const shops = data.shopInstallations.filter(shop => shop.tenantId === client.tenantId && (!client.installationIds || client.installationIds.includes(shop.id)))
    return { client, shops: shops.map(shop => ({ gatewayAccountId: shop.id, channel: 'wechat_shop', name: shop.name || shop.shopName || '微信小店', appId: shop.appId, status: shop.status })) }
  }

  async bind(token, bindings) {
    const client = await this.authenticate(token)
    if (!client) fail('local_client_unauthorized')
    const discovery = await this.discovery(token)
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100 ||
      new Set(bindings.map(row => row.accountId)).size !== bindings.length ||
      new Set(bindings.map(row => row.gatewayAccountId)).size !== bindings.length ||
      bindings.some(row => !Number.isSafeInteger(row.accountId) || row.accountId <= 0 || !discovery.shops.some(shop => shop.gatewayAccountId === row.gatewayAccountId))) fail('local_binding_invalid')
    return this.store.transaction(data => {
      const target = data.localClients.find(row => row.id === client.id && row.status === 'active')
      if (!target) fail('local_client_unauthorized')
      const normalized = bindings.map(row => ({ accountId: row.accountId, gatewayAccountId: row.gatewayAccountId })).sort((a, b) => a.accountId - b.accountId)
      if (target.bindings && JSON.stringify(target.bindings) !== JSON.stringify(normalized)) fail('local_binding_changed')
      if (data.localClients.some(row => row.id !== client.id && row.status === 'active' && row.bindings?.some(binding => normalized.some(next => next.gatewayAccountId === binding.gatewayAccountId)))) fail('local_shop_already_owned')
      target.bindings = normalized
      return { ...publicClient(target), bindings: normalized }
    })
  }

  detach(clientId, installationId, actorId = clientId) {
    return this.store.transaction(data => {
      const client = data.localClients.find(row => row.id === clientId && row.status === 'active')
      if (!client || !data.shopInstallations.some(row => row.id === installationId && row.tenantId === client.tenantId)) fail('local_client_unauthorized')
      if (!client.bindings?.some(row => row.gatewayAccountId === installationId)) return publicClient(client)
      client.bindings = (client.bindings || []).filter(row => row.gatewayAccountId !== installationId)
      client.installationIds = (client.installationIds || data.shopInstallations.filter(row => row.tenantId === client.tenantId).map(row => row.id)).filter(id => id !== installationId)
      if (!client.bindings.length) client.status = 'revoked'
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'local.shop_detach', targetType: 'shop', targetId: installationId, createdAt: new Date(this.now()).toISOString() })
      return publicClient(client)
    })
  }

  revoke(clientId, tenantId, actorId) {
    return this.store.transaction(data => {
      const client = data.localClients.find(row => row.id === clientId && row.tenantId === tenantId)
      if (!client) fail('local_client_not_found')
      client.status = 'revoked'
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'local.client_revoke', targetType: 'local_client', targetId: client.id, createdAt: new Date(this.now()).toISOString() })
      return publicClient(client)
    })
  }
}

module.exports = { LocalWorkbenchPairing }
