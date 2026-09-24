const { createHash, randomBytes: cryptoRandomBytes, randomUUID } = require('node:crypto')
const { QueryTypes } = require('sequelize')

const PAIRING_TTL_MS = 10 * 60 * 1000
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

class BridgeDomainError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeDomainError'
    this.code = code
  }
}

function hashSecret(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function encodeBase32(buffer) {
  let bits = ''
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0')
  let output = ''
  for (let index = 0; index < bits.length; index += 5) {
    output += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)]
  }
  return output
}

function createPairingService({
  repository,
  now = () => new Date(),
  randomBytes = cryptoRandomBytes
}) {
  if (!repository) throw new TypeError('repository is required')

  return {
    async create({ displayName, allowedAdapterIds = [], createdBy }) {
      const code = encodeBase32(randomBytes(5)).slice(0, 8)
      const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS)
      const pairing = await repository.insertPairing({
        codeHash: hashSecret(code),
        displayName,
        allowedAdapterIds,
        createdBy,
        expiresAt
      })
      return { id: pairing.id, code, expiresAt }
    },

    consume({ code, ...nodeDetails }) {
      if (!/^[A-Z2-7]{8}$/.test(String(code || ''))) {
        throw new BridgeDomainError('PAIRING_INVALID', 'Pairing code is invalid')
      }
      return repository.consumePairing({ codeHash: hashSecret(code), ...nodeDetails })
    }
  }
}

function mapBinding(row) {
  if (!row) return null
  return {
    id: row.id,
    channelAccountId: row.channel_account_id,
    preferredNodeId: row.preferred_node_id,
    adapterId: row.adapter_id,
    mode: row.mode,
    aiMode: row.ai_mode,
    enabled: Boolean(row.enabled)
  }
}

function mapLease(row) {
  if (!row) return null
  return {
    channelAccountId: row.channel_account_id,
    nodeId: row.node_id,
    leaseTokenHash: row.lease_token_hash,
    generation: Number(row.generation),
    expiresAt: new Date(row.expires_at),
    heartbeatAt: new Date(row.heartbeat_at)
  }
}

function createBridgeRepository(sequelize, { now = () => new Date(), randomBytes = cryptoRandomBytes } = {}) {
  if (!sequelize) throw new TypeError('sequelize is required')

  return {
    async insertPairing({ codeHash, displayName, allowedAdapterIds, createdBy, expiresAt }) {
      const [, metadata] = await sequelize.query(
        `INSERT INTO desktop_bridge_pairings
           (code_hash, display_name, allowed_adapter_ids, expires_at, created_by, created_at, updated_at)
         VALUES (:codeHash, :displayName, :allowedAdapterIds, :expiresAt, :createdBy, NOW(3), NOW(3))`,
        {
          replacements: {
            codeHash,
            displayName,
            allowedAdapterIds: JSON.stringify(allowedAdapterIds || []),
            expiresAt,
            createdBy: createdBy || null
          }
        }
      )
      return { id: metadata }
    },

    async consumePairing({ codeHash, machineFingerprint, displayName, version, adapterIds = [], capabilities = {} }) {
      return sequelize.transaction(async transaction => {
        const pairings = await sequelize.query(
          `SELECT * FROM desktop_bridge_pairings
           WHERE code_hash = :codeHash AND consumed_at IS NULL AND expires_at > :now
           FOR UPDATE`,
          { replacements: { codeHash, now: now() }, type: QueryTypes.SELECT, transaction }
        )
        const pairing = pairings[0]
        if (!pairing) throw new BridgeDomainError('PAIRING_INVALID_OR_EXPIRED', 'Pairing code is invalid, expired, or already used')

        const fingerprintHash = hashSecret(machineFingerprint)
        const existingNodes = await sequelize.query(
          'SELECT * FROM desktop_bridge_nodes WHERE machine_fingerprint_hash = :fingerprintHash FOR UPDATE',
          { replacements: { fingerprintHash }, type: QueryTypes.SELECT, transaction }
        )
        const existing = existingNodes[0]
        const enrollmentToken = randomBytes(32).toString('base64url')
        const enrollmentTokenHash = hashSecret(enrollmentToken)
        let nodeId
        let nodeKey

        if (existing) {
          nodeId = existing.id
          nodeKey = existing.node_key
          await sequelize.query(
            `UPDATE desktop_bridge_nodes
             SET display_name = :displayName, enrollment_token_hash = :enrollmentTokenHash,
                 agent_version = :version, allowed_adapter_ids = :allowedAdapterIds,
                 capabilities = :capabilities, status = 'offline', disabled_at = NULL, updated_at = NOW(3)
             WHERE id = :nodeId`,
            {
              replacements: {
                nodeId,
                displayName: displayName || pairing.display_name,
                enrollmentTokenHash,
                version,
                allowedAdapterIds: pairing.allowed_adapter_ids || JSON.stringify(adapterIds),
                capabilities: JSON.stringify(capabilities)
              },
              transaction
            }
          )
        } else {
          nodeKey = randomUUID()
          await sequelize.query(
            `INSERT INTO desktop_bridge_nodes
               (node_key, display_name, machine_fingerprint_hash, enrollment_token_hash,
                agent_version, allowed_adapter_ids, capabilities, status, created_at, updated_at)
             VALUES (:nodeKey, :displayName, :fingerprintHash, :enrollmentTokenHash,
                     :version, :allowedAdapterIds, :capabilities, 'offline', NOW(3), NOW(3))`,
            {
              replacements: {
                nodeKey,
                displayName: displayName || pairing.display_name,
                fingerprintHash,
                enrollmentTokenHash,
                version,
                allowedAdapterIds: pairing.allowed_adapter_ids || JSON.stringify(adapterIds),
                capabilities: JSON.stringify(capabilities)
              },
              transaction
            }
          )
          const rows = await sequelize.query(
            'SELECT id FROM desktop_bridge_nodes WHERE node_key = :nodeKey',
            { replacements: { nodeKey }, type: QueryTypes.SELECT, transaction }
          )
          nodeId = rows[0].id
        }

        await sequelize.query(
          `UPDATE desktop_bridge_pairings
           SET consumed_by_node_id = :nodeId, consumed_at = NOW(3), updated_at = NOW(3)
           WHERE id = :pairingId AND consumed_at IS NULL`,
          { replacements: { nodeId, pairingId: pairing.id }, transaction }
        )
        await sequelize.query(
          `INSERT INTO desktop_bridge_audit_logs
             (node_id, actor_kind, action, target_kind, target_id, outcome, created_at)
           VALUES (:nodeId, 'system', 'node.enroll', 'node', :nodeId, 'success', NOW(3))`,
          { replacements: { nodeId }, transaction }
        )
        return { nodeId, nodeKey, enrollmentToken }
      })
    },

    async authenticateNode({ nodeKey, enrollmentToken, machineFingerprint }) {
      const rows = await sequelize.query(
        `SELECT * FROM desktop_bridge_nodes
         WHERE node_key = :nodeKey AND enrollment_token_hash = :tokenHash
           AND machine_fingerprint_hash = :fingerprintHash AND disabled_at IS NULL`,
        {
          replacements: {
            nodeKey,
            tokenHash: hashSecret(enrollmentToken),
            fingerprintHash: hashSecret(machineFingerprint)
          },
          type: QueryTypes.SELECT
        }
      )
      return rows[0] || null
    },

    async touchNode(nodeId, { version, capabilities, status = 'online' } = {}) {
      await sequelize.query(
        `UPDATE desktop_bridge_nodes
         SET status = :status, agent_version = COALESCE(:version, agent_version),
             capabilities = COALESCE(:capabilities, capabilities), last_seen_at = NOW(3), updated_at = NOW(3)
         WHERE id = :nodeId AND disabled_at IS NULL`,
        {
          replacements: {
            nodeId,
            status,
            version: version || null,
            capabilities: capabilities ? JSON.stringify(capabilities) : null
          }
        }
      )
    },

    async withLeaseLock(accountId, callback) {
      return sequelize.transaction(async transaction => {
        const accounts = await sequelize.query(
          'SELECT id, channel FROM channel_accounts WHERE id = :accountId FOR UPDATE',
          { replacements: { accountId }, type: QueryTypes.SELECT, transaction }
        )
        if (!accounts[0]) throw new BridgeDomainError('ACCOUNT_NOT_FOUND', 'Channel account does not exist')

        const bindings = await sequelize.query(
          'SELECT * FROM desktop_bridge_bindings WHERE channel_account_id = :accountId FOR UPDATE',
          { replacements: { accountId }, type: QueryTypes.SELECT, transaction }
        )
        const leases = await sequelize.query(
          'SELECT * FROM desktop_bridge_leases WHERE channel_account_id = :accountId FOR UPDATE',
          { replacements: { accountId }, type: QueryTypes.SELECT, transaction }
        )

        return callback({
          account: accounts[0],
          binding: mapBinding(bindings[0]),
          lease: mapLease(leases[0]),
          saveLease: async lease => sequelize.query(
            `INSERT INTO desktop_bridge_leases
               (channel_account_id, node_id, lease_token_hash, generation, expires_at, heartbeat_at, created_at, updated_at)
             VALUES (:accountId, :nodeId, :leaseTokenHash, :generation, :expiresAt, :heartbeatAt, NOW(3), NOW(3))
             ON DUPLICATE KEY UPDATE node_id = VALUES(node_id), lease_token_hash = VALUES(lease_token_hash),
               generation = VALUES(generation), expires_at = VALUES(expires_at),
               heartbeat_at = VALUES(heartbeat_at), updated_at = NOW(3)`,
            { replacements: { accountId, ...lease }, transaction }
          ),
          writeAudit: async audit => sequelize.query(
            `INSERT INTO desktop_bridge_audit_logs
               (node_id, channel_account_id, actor_kind, actor_id, action, target_kind,
                target_id, before_json, after_json, reason, outcome, created_at)
             VALUES (:nodeId, :accountId, :actorKind, :actorId, :action, 'lease', :accountId,
                     :beforeJson, :afterJson, :reason, 'success', NOW(3))`,
            {
              replacements: {
                nodeId: audit.nodeId || null,
                accountId,
                actorKind: audit.actorKind || 'system',
                actorId: audit.actorId || null,
                action: audit.action,
                beforeJson: audit.before ? JSON.stringify(audit.before) : null,
                afterJson: audit.after ? JSON.stringify(audit.after) : null,
                reason: audit.reason || null
              },
              transaction
            }
          )
        })
      })
    }
  }
}

module.exports = {
  BridgeDomainError,
  PAIRING_TTL_MS,
  createBridgeRepository,
  createPairingService,
  hashSecret
}
