const crypto = require('crypto')

function creditBalance(data, tenantId) {
  return data.creditEntries.filter(item => item.tenantId === tenantId).reduce((sum, item) => sum + item.delta, 0)
}

function positiveInteger(value, field = 'credits') {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw Object.assign(new Error(`${field} must be a positive integer`), { code: 'invalid_credits' })
  return number
}

class TokenLedger {
  constructor(store, now = () => new Date().toISOString()) {
    this.store = store
    this.now = now
  }

  grant({ tenantId, credits, actorId, reason, idempotencyKey = crypto.randomUUID() }) {
    return this.store.transaction(data => {
      const existing = data.creditEntries.find(item => item.idempotencyKey === idempotencyKey)
      if (existing) return { entry: existing, balance: creditBalance(data, tenantId), duplicate: true }
      if (!data.tenants.some(item => item.id === tenantId)) throw Object.assign(new Error('tenant not found'), { code: 'tenant_not_found' })
      const entry = {
        id: crypto.randomUUID(), tenantId, delta: positiveInteger(credits), kind: 'manual_grant',
        reason: String(reason || '人工加额').slice(0, 120), actorId, idempotencyKey, createdAt: this.now()
      }
      data.creditEntries.push(entry)
      data.auditEntries.push({ id: crypto.randomUUID(), actorId, action: 'credits.grant', targetType: 'tenant', targetId: tenantId, metadata: { credits: entry.delta, reason: entry.reason }, createdAt: entry.createdAt })
      return { entry, balance: creditBalance(data, tenantId), duplicate: false }
    })
  }

  reserve({ tenantId, credits, idempotencyKey, model, deviceId }) {
    return this.store.transaction(data => {
      const existing = data.reservations.find(item => item.tenantId === tenantId && item.idempotencyKey === idempotencyKey)
      if (existing) return { reservation: existing, balance: creditBalance(data, tenantId), duplicate: true }
      const amount = positiveInteger(credits)
      if (!idempotencyKey) throw Object.assign(new Error('idempotencyKey is required'), { code: 'idempotency_key_required' })
      if (creditBalance(data, tenantId) < amount) throw Object.assign(new Error('insufficient credits'), { code: 'insufficient_credits' })
      const createdAt = this.now()
      const reservation = { id: crypto.randomUUID(), tenantId, reservedCredits: amount, actualCredits: null, status: 'reserved', idempotencyKey, model: String(model || ''), deviceId, createdAt, updatedAt: createdAt }
      data.reservations.push(reservation)
      data.creditEntries.push({ id: crypto.randomUUID(), tenantId, delta: -amount, kind: 'reservation', reservationId: reservation.id, idempotencyKey: `reserve:${idempotencyKey}`, createdAt })
      return { reservation, balance: creditBalance(data, tenantId), duplicate: false }
    })
  }

  settle({ tenantId, reservationId, actualCredits }) {
    return this.store.transaction(data => {
      const reservation = data.reservations.find(item => item.id === reservationId && item.tenantId === tenantId)
      if (!reservation) throw Object.assign(new Error('reservation not found'), { code: 'reservation_not_found' })
      if (reservation.status === 'settled') return { reservation, balance: creditBalance(data, tenantId), duplicate: true }
      if (reservation.status !== 'reserved') throw Object.assign(new Error('reservation is not active'), { code: 'reservation_not_active' })
      const actual = positiveInteger(actualCredits, 'actualCredits')
      const adjustment = reservation.reservedCredits - actual
      if (adjustment < 0 && creditBalance(data, tenantId) < Math.abs(adjustment)) throw Object.assign(new Error('insufficient credits to settle'), { code: 'insufficient_credits' })
      if (adjustment !== 0) data.creditEntries.push({ id: crypto.randomUUID(), tenantId, delta: adjustment, kind: 'settlement_adjustment', reservationId, idempotencyKey: `settle:${reservationId}`, createdAt: this.now() })
      reservation.actualCredits = actual
      reservation.status = 'settled'
      reservation.updatedAt = this.now()
      return { reservation, balance: creditBalance(data, tenantId), duplicate: false }
    })
  }

  cancel({ tenantId, reservationId }) {
    return this.store.transaction(data => {
      const reservation = data.reservations.find(item => item.id === reservationId && item.tenantId === tenantId)
      if (!reservation) throw Object.assign(new Error('reservation not found'), { code: 'reservation_not_found' })
      if (reservation.status === 'cancelled') return { reservation, balance: creditBalance(data, tenantId), duplicate: true }
      if (reservation.status !== 'reserved') throw Object.assign(new Error('reservation is not active'), { code: 'reservation_not_active' })
      data.creditEntries.push({ id: crypto.randomUUID(), tenantId, delta: reservation.reservedCredits, kind: 'reservation_release', reservationId, idempotencyKey: `cancel:${reservationId}`, createdAt: this.now() })
      reservation.status = 'cancelled'
      reservation.updatedAt = this.now()
      return { reservation, balance: creditBalance(data, tenantId), duplicate: false }
    })
  }
}

module.exports = { TokenLedger, creditBalance }
