const test = require('node:test')
const assert = require('node:assert/strict')
const {
  PAIRING_TTL_MS,
  createPairingService,
  hashSecret
} = require('./bridgeRepository')

test('creates eight-character uppercase base32 pairing codes that expire after ten minutes', async () => {
  const captured = []
  const now = new Date('2026-07-31T10:00:00.000Z')
  const repository = {
    insertPairing: async record => { captured.push(record); return { id: 41 } }
  }
  const service = createPairingService({
    repository,
    now: () => now,
    randomBytes: () => Buffer.from([0, 1, 2, 3, 4])
  })

  const result = await service.create({ displayName: '客服电脑 A', allowedAdapterIds: ['qianniu'], createdBy: 9 })

  assert.match(result.code, /^[A-Z2-7]{8}$/)
  assert.equal(result.expiresAt.getTime() - now.getTime(), PAIRING_TTL_MS)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].codeHash, hashSecret(result.code))
  assert.equal(JSON.stringify(captured[0]).includes(result.code), false)
})

test('passes only a code hash to the one-time pairing consumer', async () => {
  const consumed = new Set()
  const repository = {
    consumePairing: async input => {
      assert.equal('code' in input, false)
      if (consumed.has(input.codeHash)) {
        const error = new Error('already used')
        error.code = 'PAIRING_ALREADY_USED'
        throw error
      }
      consumed.add(input.codeHash)
      return { nodeId: 11, nodeKey: crypto.randomUUID(), enrollmentToken: 'x'.repeat(32) }
    }
  }
  const service = createPairingService({ repository })
  const input = {
    code: 'ABCDEFGH',
    machineFingerprint: 'machine-a',
    version: '1.0.0',
    capabilities: { qianniu: true }
  }

  assert.equal((await service.consume(input)).nodeId, 11)
  await assert.rejects(() => service.consume(input), error => error.code === 'PAIRING_ALREADY_USED')
})
