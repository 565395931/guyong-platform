class GatewayAccountMapper {
  constructor(entries = []) {
    this.byAccountId = new Map()
    this.byGatewayAccountId = new Map()
    for (const entry of entries) this.set(entry)
  }

  set({ accountId, gatewayAccountId, channel }) {
    if (accountId === undefined || !gatewayAccountId) throw new Error('accountId and gatewayAccountId are required')
    const record = { accountId: Number(accountId), gatewayAccountId: String(gatewayAccountId), channel: channel || null }
    this.byAccountId.set(record.accountId, record)
    this.byGatewayAccountId.set(record.gatewayAccountId, record)
    return record
  }

  resolveByAccountId(accountId) { return this.byAccountId.get(Number(accountId)) || null }
  resolveByGatewayAccountId(id) { return this.byGatewayAccountId.get(String(id)) || null }
  has(accountId) { return this.byAccountId.has(Number(accountId)) }
}

module.exports = GatewayAccountMapper
