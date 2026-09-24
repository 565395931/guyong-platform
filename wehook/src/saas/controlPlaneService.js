const crypto = require('crypto')
const { hashPassword, verifyPassword, hashToken, createOpaqueToken } = require('./security')
const { creditBalance } = require('./tokenLedger')

function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
}

class ControlPlaneService {
  constructor(store, ledger, now = () => new Date().toISOString()) {
    this.store = store
    this.ledger = ledger
    this.now = now
  }

  bootstrap({ adminUsername, adminPassword }) {
    return this.store.transaction(data => {
      if (!data.plans.length) data.plans.push({ id: 'starter', name: '启航套餐', monthlyCredits: 100000, status: 'active', createdAt: this.now() })
      if (!data.users.some(item => item.role === 'operator')) {
        data.users.push({ id: crypto.randomUUID(), username: adminUsername, passwordHash: hashPassword(adminPassword, undefined, 8), role: 'operator', tenantId: null, status: 'active', mustChangePassword: true, createdAt: this.now() })
      }
    })
  }

  async authenticate(username, password, surface) {
    const data = await this.store.snapshot()
    const user = data.users.find(item => item.username === String(username || '').trim() && item.status === 'active')
    if (!user || !verifyPassword(password, user.passwordHash)) return null
    if (surface === 'admin' && user.role !== 'operator') return null
    if (surface === 'account' && user.role !== 'tenant_admin') return null
    return { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId, mustChangePassword: Boolean(user.mustChangePassword) }
  }

  changePassword({ userId, currentPassword, newPassword }) {
    return this.store.transaction(data => {
      const user = data.users.find(item => item.id === userId && item.status === 'active')
      if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw Object.assign(new Error('当前密码不正确'), { code: 'invalid_current_password' })
      if (String(newPassword || '').length < 12) throw Object.assign(new Error('新密码至少需要 12 个字符'), { code: 'weak_password' })
      if (verifyPassword(newPassword, user.passwordHash)) throw Object.assign(new Error('新密码不能与当前密码相同'), { code: 'password_unchanged' })
      user.passwordHash = hashPassword(newPassword)
      user.mustChangePassword = false
      user.passwordChangedAt = this.now()
      data.auditEntries.push({ id: crypto.randomUUID(), actorId: user.id, action: 'account.password_change', targetType: 'user', targetId: user.id, metadata: {}, createdAt: user.passwordChangedAt })
      return { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId, mustChangePassword: false }
    })
  }

  createTenant({ name, slug, accountUsername, accountPassword, actorId }) {
    return this.store.transaction(data => {
      const normalizedSlug = slugify(slug || name)
      if (!String(name || '').trim() || !normalizedSlug) throw Object.assign(new Error('name and slug are required'), { code: 'invalid_tenant' })
      if (data.tenants.some(item => item.slug === normalizedSlug)) throw Object.assign(new Error('tenant slug already exists'), { code: 'tenant_conflict' })
      if (data.users.some(item => item.username === accountUsername)) throw Object.assign(new Error('username already exists'), { code: 'username_conflict' })
      const createdAt = this.now()
      const tenant = { id: crypto.randomUUID(), name: String(name).trim(), slug: normalizedSlug, status: 'active', createdAt }
      data.tenants.push(tenant)
      data.users.push({ id: crypto.randomUUID(), username: String(accountUsername).trim(), passwordHash: hashPassword(accountPassword), role: 'tenant_admin', tenantId: tenant.id, status: 'active', createdAt })
      data.subscriptions.push({ id: crypto.randomUUID(), tenantId: tenant.id, planId: 'starter', status: 'trial', startedAt: createdAt })
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'tenant.create', targetType: 'tenant', targetId: tenant.id, metadata: { name: tenant.name, slug: tenant.slug }, createdAt })
      return tenant
    })
  }

  registerWecomInstallation({ tenantId, corpId, companyName, callbackKey, actorId }) {
    return this.store.transaction(data => {
      if (!data.tenants.some(item => item.id === tenantId)) throw Object.assign(new Error('tenant not found'), { code: 'tenant_not_found' })
      if (!/^ww[a-zA-Z0-9_-]{3,}$/.test(String(corpId || ''))) throw Object.assign(new Error('invalid corpId'), { code: 'invalid_corp_id' })
      const existing = data.wecomInstallations.find(item => item.corpId === corpId)
      if (existing && existing.tenantId !== tenantId) throw Object.assign(new Error('corpId belongs to another tenant'), { code: 'corp_id_conflict' })
      const createdAt = this.now()
      const installation = existing || { id: crypto.randomUUID(), tenantId, corpId, createdAt }
      installation.companyName = String(companyName || '').trim().slice(0, 100)
      installation.callbackKey = String(callbackKey || crypto.randomBytes(12).toString('base64url')).slice(0, 64)
      installation.status = 'pending_callback'
      installation.updatedAt = createdAt
      if (!existing) data.wecomInstallations.push(installation)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: existing ? 'wecom.update' : 'wecom.register', targetType: 'wecom_installation', targetId: installation.id, metadata: { tenantId, corpId }, createdAt })
      return installation
    })
  }

  issueDevice({ tenantId, name, actorId }) {
    return this.store.transaction(data => {
      if (!data.tenants.some(item => item.id === tenantId)) throw Object.assign(new Error('tenant not found'), { code: 'tenant_not_found' })
      const token = createOpaqueToken('lwd')
      const createdAt = this.now()
      const device = { id: crypto.randomUUID(), tenantId, name: String(name || '本地客服端').trim().slice(0, 80), tokenHash: hashToken(token), tokenPreview: `${token.slice(0, 8)}…${token.slice(-4)}`, status: 'active', lastSeenAt: null, createdAt }
      data.devices.push(device)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'device.issue', targetType: 'device', targetId: device.id, metadata: { tenantId, name: device.name }, createdAt })
      return { device: this.publicDevice(device), token }
    })
  }

  async authenticateDevice(token) {
    const data = await this.store.snapshot()
    const digest = hashToken(token)
    const device = data.devices.find(item => item.tokenHash === digest && item.status === 'active')
    return device ? { id: device.id, tenantId: device.tenantId, name: device.name } : null
  }

  publicDevice(device) {
    const { tokenHash, ...safe } = device
    return safe
  }

  async adminOverview() {
    const data = await this.store.snapshot()
    const tenants = data.tenants.map(tenant => ({ ...tenant, balance: creditBalance(data, tenant.id), devices: data.devices.filter(item => item.tenantId === tenant.id).length, wecom: data.wecomInstallations.filter(item => item.tenantId === tenant.id).length }))
    return { tenants, installations: data.wecomInstallations, ledger: data.creditEntries.slice().reverse().slice(0, 100), audit: data.auditEntries.slice().reverse().slice(0, 50), totals: { tenants: tenants.length, credits: tenants.reduce((sum, item) => sum + item.balance, 0), installations: data.wecomInstallations.length, devices: data.devices.length } }
  }

  async accountOverview(tenantId) {
    const data = await this.store.snapshot()
    const tenant = data.tenants.find(item => item.id === tenantId)
    if (!tenant) throw Object.assign(new Error('tenant not found'), { code: 'tenant_not_found' })
    const subscription = data.subscriptions.find(item => item.tenantId === tenantId)
    const plan = data.plans.find(item => item.id === subscription?.planId) || null
    return { tenant, balance: creditBalance(data, tenantId), subscription, plan, devices: data.devices.filter(item => item.tenantId === tenantId).map(item => this.publicDevice(item)), installations: data.wecomInstallations.filter(item => item.tenantId === tenantId), ledger: data.creditEntries.filter(item => item.tenantId === tenantId).slice().reverse().slice(0, 50) }
  }
}

module.exports = ControlPlaneService
