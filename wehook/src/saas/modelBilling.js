const crypto = require('crypto')
const { LIMIT, requestHash, allCalls, findCall, totalsFor } = require('./modelCallRetention')

// Integer nano-yuan: one yuan = 1e9 units. Legacy credits are never converted.
const UNIT = 1_000_000_000
const PLAN = Object.freeze({ id: 'token-100', name: 'Token 预充值套餐', amountYuan: 100, currency: 'CNY' })
const DEFAULT_PRICING = Object.freeze({
  version: 1, timezone: 'Asia/Shanghai', textCostPercent: 60, visionCostPercent: 100,
  text: { input: 1, cached: 0.02, output: 4 },
  peakMorning: { input: 2, cached: 0.04, output: 8 },
  peakAfternoon: { input: 2, cached: 0.04, output: 2 },
  vision: { input: 1, cached: 0.02, output: 4 }
})
function fail(message, code = 'billing_invalid') { throw Object.assign(new Error(message), { code }) }
function balance(data, tenantId) { return (data.moneyEntries || []).filter(x => x.tenantId === tenantId).reduce((n, x) => n + x.delta, 0) }
function integer(n, label) { if (!Number.isSafeInteger(n) || n < 0) fail(`${label}必须为非负整数`); return n }
function rateUnits(n) { if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10000) fail('单价必须为 0–10000 元／百万 Token'); return Math.round(n * UNIT) }
function price(tokens, rate) { return Number((BigInt(integer(tokens, 'Token')) * BigInt(rateUnits(rate)) + 999999n) / 1000000n) }
function ratesAt(config, kind, date) {
  const local = new Date(new Date(date).getTime() + 8 * 3600 * 1000)
  const weekday = local.getUTCDay(), minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  const band = weekday >= 1 && weekday <= 5 && minute >= 540 && minute < 720 ? 'peakMorning'
    : weekday >= 1 && weekday <= 5 && minute >= 840 && minute < 1080 ? 'peakAfternoon' : 'text'
  if (kind === 'vision') { if (!config.vision) fail('请先配置视觉模型价格', 'vision_not_configured'); return { band: `vision:${band}`, rates: band === 'text' ? config.vision : config[band] } }
  return { band, rates: config[band] }
}
function normalizeUsage(usage) {
  if (!usage || usage.prompt_tokens == null || usage.completion_tokens == null) fail('供应商未返回完整用量，等待核账', 'usage_missing')
  const input = integer(usage.prompt_tokens, '输入 Token'), output = integer(usage.completion_tokens, '输出 Token')
  const cached = integer(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0, '缓存 Token')
  if (cached > input) fail('缓存 Token 不能超过总输入 Token', 'usage_invalid')
  return { input, cached, uncached: input - cached, output }
}
function charge(usage, rates, percent) {
  const sale = price(usage.uncached, rates.input) + price(usage.cached, rates.cached) + price(usage.output, rates.output)
  const cost = Number((BigInt(sale) * BigInt(percent) + 99n) / 100n)
  return { sale, cost, profit: sale - cost }
}
function hasImages(messages) { return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url' || p.type === 'input_image')) }

class ModelBilling {
  constructor({ store, messaging, modelClient, now = () => new Date().toISOString() }) { Object.assign(this, { store, messaging, modelClient, now }) }
  async config() { const d = await this.store.snapshot(); return d.billingConfigs?.[0] || structuredClone(DEFAULT_PRICING) }
  async savePricing(input, actorId) {
    const next = { ...structuredClone(DEFAULT_PRICING), ...input, timezone: 'Asia/Shanghai', textCostPercent: 60, visionCostPercent: 100 }
    for (const key of ['text', 'peakMorning', 'peakAfternoon', 'vision']) {
      if (key === 'vision' && next[key] == null) continue
      for (const field of ['input', 'cached', 'output']) rateUnits(next[key]?.[field])
    }
    return this.store.transaction(d => {
      next.version = (d.billingConfigs?.[0]?.version || 0) + 1; next.updatedAt = this.now()
      d.billingConfigs = [next]
      d.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'billing.pricing_update', createdAt: next.updatedAt, metadata: { version: next.version } })
      return next
    })
  }
  async wallet(tenantId) {
    const d = await this.store.snapshot()
    return { currency: 'CNY', unit: UNIT, balance: balance(d, tenantId), updatedAt: this.now() }
  }
  async setBalance({ tenantId, amountYuan, expectedBalance, reference, idempotencyKey, actorId }) {
    if (typeof amountYuan !== 'number' || !Number.isFinite(amountYuan) || amountYuan < 0 || amountYuan > 1000000) fail('余额必须为 0–1000000 元')
    const target = Math.round(amountYuan * UNIT)
    if (!Number.isSafeInteger(target) || !String(reference || '').trim() || !idempotencyKey) fail('请填写有效余额及调整说明')
    return this.store.transaction(d => {
      if (!d.tenants.some(t => t.id === tenantId && t.status === 'active')) fail('客户不存在或已停用', 'tenant_not_found')
      const old = d.moneyEntries.find(e => e.tenantId === tenantId && e.kind === 'balance_adjustment' && e.idempotencyKey === idempotencyKey)
      if (old) { if (old.target !== target || old.reference !== reference) fail('重复调整内容不一致', 'billing_conflict'); return old }
      const previous = balance(d, tenantId)
      if (expectedBalance !== previous) fail('余额已变化，请刷新后再调整', 'billing_conflict')
      const user = d.users.find(u => u.tenantId === tenantId && u.role === 'tenant_admin')
      const row = { id: crypto.randomUUID(), tenantId, userId: user?.id, actorId, kind: 'balance_adjustment', delta: target - previous, previous, target, reference, idempotencyKey, createdAt: this.now() }
      d.moneyEntries.push(row)
      d.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'billing.balance_adjustment', targetId: row.id, metadata: { tenantId, previous, target, reference }, createdAt: row.createdAt })
      return row
    })
  }
  async issue({ tenantId, actorId, reference, idempotencyKey, test = false }) {
    if (!idempotencyKey || !String(reference || '').trim()) fail('请填写订单／测试编号及幂等键')
    return this.store.transaction(d => {
      if (!d.tenants.some(t => t.id === tenantId && t.status === 'active')) fail('客户不存在或已停用', 'tenant_not_found')
      const old = d.packageOrders.find(o => o.tenantId === tenantId && o.idempotencyKey === idempotencyKey)
      if (old) { if (old.reference !== reference || old.test !== test) fail('同一订单编号不能用于不同操作', 'billing_conflict'); return old }
      if (d.packageOrders.some(o => o.tenantId === tenantId && o.reference === reference)) fail('订单编号已使用', 'billing_conflict')
      const user = d.users.find(u => u.tenantId === tenantId && u.role === 'tenant_admin' && u.status === 'active')
      const row = { id: crypto.randomUUID(), tenantId, userId: user?.id, planId: PLAN.id, amount: 100 * UNIT, paidAmount: test ? 0 : 100 * UNIT, test, reference, actorId, idempotencyKey, createdAt: this.now() }
      d.packageOrders.push(row)
      if (!d.plans.some(p => p.id === PLAN.id)) d.plans.push({ ...PLAN, status: 'active', createdAt: row.createdAt })
      const subscription = d.subscriptions.find(s => s.tenantId === tenantId && s.planId === PLAN.id)
      if (!subscription) d.subscriptions.push({ id: crypto.randomUUID(), tenantId, userId: user?.id, planId: PLAN.id, status: test ? 'test' : 'active', startedAt: row.createdAt })
      else if (!test) subscription.status = 'active'
      d.moneyEntries.push({ id: crypto.randomUUID(), tenantId, delta: row.amount, kind: test ? 'test_package' : 'package_purchase', orderId: row.id, createdAt: row.createdAt })
      d.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'billing.package_issue', targetId: row.id, metadata: { tenantId, test }, createdAt: row.createdAt })
      return row
    })
  }
  async overview(tenantId, { includeCalls = true } = {}) {
    const d = await this.store.snapshot(), orders = d.packageOrders.filter(x => !tenantId || x.tenantId === tenantId)
    const calls = d.modelCalls.filter(x => !tenantId || x.tenantId === tenantId)
    const totals = totalsFor(d, tenantId)
    const entries = d.moneyEntries.filter(x => !tenantId || x.tenantId === tenantId)
    const publicCalls = (includeCalls ? calls : []).slice().reverse().slice(0, LIMIT).map(({ response, fingerprint, ...x }) => tenantId ? (({ cost, profit, ...safe }) => safe)(x) : x)
    const pricing = await this.config()
    if (tenantId) { delete pricing.textCostPercent; delete pricing.visionCostPercent }
    return { unit: UNIT, currency: 'CNY', plan: PLAN, pricing, balance: entries.reduce((n, x) => n + x.delta, 0), orders: orders.slice().reverse().slice(0, 200), calls: publicCalls, entries: entries.slice().reverse().slice(0, 200), totals: tenantId ? { sale: totals.sale, input: totals.input, output: totals.output, cached: totals.cached } : totals,
      customers: tenantId ? undefined : d.tenants.map(t => ({ id: t.id, name: t.name, balance: balance(d, t.id), packages: orders.filter(o => o.tenantId === t.id).length, paidAmount: orders.filter(o => o.tenantId === t.id).reduce((n, o) => n + o.paidAmount, 0), ...totalsFor(d, t.id) })) }
  }
  async logs(tenantId) {
    const d = await this.store.snapshot()
    const tenant = d.tenants.find(t => t.id === tenantId)
    if (!tenant) fail('客户不存在', 'tenant_not_found')
    const calls = d.modelCalls.filter(c => c.tenantId === tenantId).slice(-LIMIT).reverse().map(({ response, fingerprint, key, ...row }) => row)
    return { tenantId, tenantName: tenant.name, calls, limit: LIMIT }
  }
  async reconcile({ callId, usage, refund, reference, actorId }) {
    if (!String(reference || '').trim()) fail('请填写供应商核账凭据编号')
    const measured = refund === true ? null : normalizeUsage(usage)
    return this.store.transaction(d => {
      const row = findCall(d, callId)
      if (!row || !['pending_reconciliation','reserved'].includes(row.status)) fail('仅待核账请求可人工处理')
      if (row.status === 'reserved' && Date.now() - new Date(row.createdAt).getTime() < 120000) fail('请求仍在处理中，请稍后核账')
      const amounts = measured ? charge(measured, row.rates, row.costPercent) : { sale: 0, cost: 0, profit: 0 }
      d.moneyEntries.push({ id: crypto.randomUUID(), tenantId: row.tenantId, callId: row.id, delta: row.reserved - amounts.sale, kind: refund ? 'reconciliation_refund' : 'reconciliation_settle', reference, createdAt: this.now() })
      Object.assign(row, amounts, { usage: measured, status: refund ? 'failed' : 'settled', updatedAt: this.now(), manuallyReconciled: true })
      d.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'billing.reconcile', targetId: row.id, metadata: { reference, refund: Boolean(refund) }, createdAt: row.updatedAt })
      return { id: row.id, status: row.status }
    })
  }
  async complete(identity, body, key) {
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 || !body.messages.every(m => m && ['system','user','assistant','tool','developer'].includes(m.role) && (typeof m.content === 'string' || Array.isArray(m.content)))) fail('messages 格式不正确')
    const allowed = ['customer-auto', 'customer-text', 'customer-vision']
    const model = body.model || 'customer-auto'
    if (!allowed.includes(model)) fail('请选择可用模型', 'model_not_available')
    if (typeof key !== 'string' || !key.length || key.length > 160) fail('请求编号不正确')
    const kind = hasImages(body.messages) || model === 'customer-vision' ? 'vision' : 'text'
    const config = await this.messaging.resolvedModelConfig()
    const modelConfig = kind === 'vision' ? { ...config, baseUrl: config.visionBaseUrl || config.baseUrl, model: config.visionModel || '', apiKey: config.visionApiKey || config.apiKey } : config
    if (!modelConfig.apiKey || !modelConfig.model) fail(kind === 'vision' ? '请先配置视觉模型' : '请先配置文本模型', 'model_api_key_required')
    const maxTokens = integer(Number(body.max_tokens ?? body.max_completion_tokens ?? config.maxTokens ?? 2000), '最大输出 Token')
    if (maxTokens < 1 || maxTokens > 8192) fail('最大输出 Token 必须为 1–8192')
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ messages: body.messages, model, maxTokens, temperature: body.temperature })).digest('hex')
    const pricing = await this.config(), at = this.now(), { band, rates } = ratesAt(pricing, kind, at)
    // Reserve the configured hard input cap, rather than trusting client token estimates.
    const reserveInput = 262144
    if (Buffer.byteLength(JSON.stringify(body.messages)) > 512000) fail('上下文过长，请缩短后重试')
    const reserved = price(reserveInput, Math.max(rates.input, rates.cached)) + price(maxTokens, rates.output)
    const claim = await this.store.transaction(d => {
      if (!d.tenants.some(t => t.id === identity.tenantId && t.status === 'active')) fail('客户已停用', 'tenant_not_found')
      const old = allCalls(d).find(c => c.tenantId === identity.tenantId && c.key === key)
      if (old) { if (old.fingerprint !== fingerprint) fail('同一请求编号对应不同内容', 'billing_conflict'); return { duplicate: true, call: old } }
      const archived = d.moneyEntries.find(e => e.tenantId === identity.tenantId && e.requestHash === requestHash(key))
      if (archived) {
        if (archived.fingerprint !== fingerprint) fail('同一请求编号对应不同内容', 'billing_conflict')
        fail('该历史请求已处理，日志已过期，请使用新的请求编号', 'billing_expired')
      }
      if (balance(d, identity.tenantId) < reserved) fail('余额不足以预留本次调用，请充值或减少输出上限', 'insufficient_balance')
      const user = d.users.find(u => u.tenantId === identity.tenantId && u.role === 'tenant_admin')
      const call = { id: crypto.randomUUID(), key, fingerprint, tenantId: identity.tenantId, userId: user?.id, deviceId: identity.id, model, upstreamModel: modelConfig.model, kind, pricingVersion: pricing.version, band, rates: { ...rates }, costPercent: kind === 'vision' ? 100 : 60, reserved, status: 'reserved', createdAt: at }
      d.modelCalls.push(call); d.moneyEntries.push({ id: crypto.randomUUID(), tenantId: identity.tenantId, callId: call.id, delta: -reserved, kind: 'model_reserve', createdAt: at })
      return { call }
    })
    if (claim.duplicate) { if (claim.call.status === 'settled' && claim.call.response) return { ...claim.call.response, billing: await this.wallet(identity.tenantId) }; fail('此请求已提交，正在处理或等待核账，请勿重复调用', 'billing_pending') }
    const call = claim.call
    let result
    try { result = await this.modelClient.complete(modelConfig, { messages: body.messages, maxTokens, temperature: body.temperature }) }
    catch (err) {
      let billedUsage
      if (err.usage) { try { billedUsage = normalizeUsage(err.usage) } catch {} }
      const definite = ['model_http_error', 'model_api_error', 'model_api_key_required', 'model_name_required', 'invalid_model_base_url'].includes(err.code)
      await this.store.transaction(d => {
        const row = findCall(d, call.id); row.status = billedUsage ? 'failed_billed' : definite ? 'failed' : 'pending_reconciliation'; row.errorCode = String(err.code || 'upstream_unknown'); row.updatedAt = this.now()
        if (billedUsage) {
          Object.assign(row, charge(billedUsage, row.rates, row.costPercent), { usage: billedUsage })
          d.moneyEntries.push({ id: crypto.randomUUID(), tenantId: row.tenantId, callId: row.id, delta: row.reserved - row.sale, kind: 'model_settle', createdAt: row.updatedAt })
        } else if (definite) d.moneyEntries.push({ id: crypto.randomUUID(), tenantId: row.tenantId, callId: row.id, delta: row.reserved, kind: 'model_release', createdAt: row.updatedAt })
      }); throw err
    }
    let usage
    try { usage = normalizeUsage(result.usage) } catch (err) {
      await this.store.transaction(d => { const row = findCall(d, call.id); row.status = 'pending_reconciliation'; row.errorCode = err.code; row.updatedAt = this.now() }); throw err
    }
    const amounts = charge(usage, rates, call.costPercent)
    const response = { id: `chatcmpl-${call.id}`, object: 'chat.completion', created: Math.floor(new Date(at).getTime()/1000), model, choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, prompt_tokens_details: { cached_tokens: usage.cached } } }
    await this.store.transaction(d => {
      const row = findCall(d, call.id)
      d.moneyEntries.push({ id: crypto.randomUUID(), tenantId: row.tenantId, callId: row.id, delta: row.reserved - amounts.sale, kind: 'model_settle', createdAt: this.now() })
      Object.assign(row, amounts, { usage, response, status: 'settled', updatedAt: this.now(), overReserve: amounts.sale > row.reserved })
    })
    return { ...response, billing: await this.wallet(identity.tenantId) }
  }
}
module.exports = { ModelBilling, UNIT, PLAN, DEFAULT_PRICING, ratesAt, normalizeUsage, charge, balance, hasImages }
