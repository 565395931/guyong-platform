const { randomBytes: cryptoRandomBytes, timingSafeEqual } = require('node:crypto')
const { BridgeDomainError, hashSecret } = require('./bridgeRepository')

const HEARTBEAT_INTERVAL_MS = 15_000
const LEASE_DURATION_MS = HEARTBEAT_INTERVAL_MS * 3

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(left || '', 'hex')
  const rightBuffer = Buffer.from(right || '', 'hex')
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function createLeaseService({
  repository,
  now = () => new Date(),
  randomBytes = cryptoRandomBytes
}) {
  if (!repository) throw new TypeError('repository is required')

  function assertBinding(context, nodeId) {
    if (!context.binding || !context.binding.enabled) {
      throw new BridgeDomainError('ACCOUNT_NOT_BOUND', 'Account has no enabled desktop bridge binding')
    }
    if (context.binding.preferredNodeId && Number(context.binding.preferredNodeId) !== Number(nodeId)) {
      throw new BridgeDomainError('NODE_NOT_BOUND', 'Node is not assigned to this account')
    }
  }

  function newLease(context, accountId, nodeId, action, actor = {}, reason) {
    const current = context.lease
    const leaseToken = randomBytes(32).toString('base64url')
    const at = now()
    const lease = {
      nodeId,
      leaseTokenHash: hashSecret(leaseToken),
      generation: (current?.generation || 0) + 1,
      expiresAt: new Date(at.getTime() + LEASE_DURATION_MS),
      heartbeatAt: at
    }
    return { lease, leaseToken, audit: {
      action,
      nodeId,
      actorKind: actor.id ? 'user' : 'node',
      actorId: actor.id ? String(actor.id) : String(nodeId),
      before: current ? { nodeId: current.nodeId, generation: current.generation } : null,
      after: { nodeId, generation: lease.generation },
      reason
    } }
  }

  return {
    acquire({ accountId, nodeId }) {
      return repository.withLeaseLock(accountId, async context => {
        assertBinding(context, nodeId)
        const at = now()
        if (context.lease && context.lease.expiresAt.getTime() > at.getTime()) {
          throw new BridgeDomainError('ACCOUNT_LEASE_CONFLICT', 'Account already has an active node lease')
        }
        const { lease, leaseToken, audit } = newLease(context, accountId, nodeId, 'lease.acquire')
        await context.saveLease(lease)
        await context.writeAudit(audit)
        return { accountId, nodeId, generation: lease.generation, leaseToken, expiresAt: lease.expiresAt }
      })
    },

    renew({ accountId, nodeId, leaseToken, generation }) {
      return repository.withLeaseLock(accountId, async context => {
        assertBinding(context, nodeId)
        const lease = context.lease
        if (!lease || Number(lease.nodeId) !== Number(nodeId) ||
            (generation != null && Number(generation) !== Number(lease.generation)) ||
            !secretsEqual(hashSecret(leaseToken), lease.leaseTokenHash)) {
          throw new BridgeDomainError('LEASE_REVOKED', 'Lease is no longer owned by this node')
        }
        const at = now()
        if (lease.expiresAt.getTime() <= at.getTime()) {
          throw new BridgeDomainError('LEASE_EXPIRED', 'Lease has expired')
        }
        const renewed = {
          ...lease,
          heartbeatAt: at,
          expiresAt: new Date(at.getTime() + LEASE_DURATION_MS)
        }
        await context.saveLease(renewed)
        return { accountId, nodeId, generation: renewed.generation, expiresAt: renewed.expiresAt }
      })
    },

    takeover({ accountId, nodeId, actor, reason }) {
      if (!actor || !['supervisor', 'admin'].includes(actor.role)) {
        throw new BridgeDomainError('TAKEOVER_FORBIDDEN', 'Supervisor or admin role is required')
      }
      const normalizedReason = String(reason || '').trim()
      if (normalizedReason.length < 5 || normalizedReason.length > 200) {
        throw new BridgeDomainError('TAKEOVER_REASON_REQUIRED', 'Takeover reason must be 5-200 characters')
      }
      return repository.withLeaseLock(accountId, async context => {
        if (!context.binding || !context.binding.enabled) {
          throw new BridgeDomainError('ACCOUNT_NOT_BOUND', 'Account has no enabled desktop bridge binding')
        }
        const { lease, leaseToken, audit } = newLease(
          context,
          accountId,
          nodeId,
          'lease.takeover',
          actor,
          normalizedReason
        )
        await context.saveLease(lease)
        await context.writeAudit(audit)
        return { accountId, nodeId, generation: lease.generation, leaseToken, expiresAt: lease.expiresAt }
      })
    }
  }
}

module.exports = { HEARTBEAT_INTERVAL_MS, LEASE_DURATION_MS, createLeaseService }
