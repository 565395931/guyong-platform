const crypto = require('crypto')
const LIMIT = 300
const emptyTotals = () => ({ sale: 0, cost: 0, profit: 0, input: 0, output: 0, cached: 0 })
const requestHash = key => crypto.createHash('sha256').update(key).digest('hex')
const allCalls = d => [...d.modelCalls, ...(d.pendingModelCalls || [])]
const findCall = (d, id) => allCalls(d).find(c => c.id === id)
function sumCalls(calls, seed = emptyTotals()) {
  return calls.filter(c => ['settled', 'failed_billed'].includes(c.status)).reduce((a, c) => {
    for (const key of ['sale', 'cost', 'profit']) a[key] += c[key] || 0
    for (const key of ['input', 'output', 'cached']) a[key] += c.usage?.[key] || 0
    return a
  }, { ...seed })
}
function compactModelCalls(d) {
  d.modelCallTotals ||= []
  const count = new Map(), retained = [], removed = []
  for (let i = d.modelCalls.length - 1; i >= 0; i--) {
    const c = d.modelCalls[i], n = (count.get(c.tenantId) || 0) + 1
    count.set(c.tenantId, n)
    if (n <= LIMIT) retained.push(c); else removed.push(c)
  }
  d.modelCalls = retained.reverse()
  const pending = []
  for (const c of [...(d.pendingModelCalls || []), ...removed]) {
    if (['reserved', 'pending_reconciliation'].includes(c.status)) { pending.push(c); continue }
    let totals = d.modelCallTotals.find(t => t.tenantId === c.tenantId)
    if (!totals) { totals = { tenantId: c.tenantId, ...emptyTotals() }; d.modelCallTotals.push(totals) }
    Object.assign(totals, sumCalls([c], totals))
    const reservation = d.moneyEntries.find(e => e.callId === c.id && e.kind === 'model_reserve')
    if (reservation) { reservation.requestHash = requestHash(c.key); reservation.fingerprint = c.fingerprint }
  }
  // Outstanding settlements remain accounting obligations, outside the rolling display log.
  d.pendingModelCalls = pending
}
function totalsFor(d, tenantId) {
  const seed = emptyTotals()
  for (const row of d.modelCallTotals || []) if (!tenantId || row.tenantId === tenantId) {
    for (const key of Object.keys(seed)) seed[key] += row[key] || 0
  }
  return sumCalls(allCalls(d).filter(c => !tenantId || c.tenantId === tenantId), seed)
}
module.exports = { LIMIT, requestHash, allCalls, findCall, compactModelCalls, totalsFor }
