const { sequelize } = require('../../config/database')
const { buildMockGatewayAccountId, MOCK_ADAPTER_TYPE } = require('./mockAccount')

const WECOM_ADAPTER_TYPE = 'wecom_official'

function mapCloudGatewayAccount(row) {
  if (!row) return null
  const adapterType = row.adapter_type
  const isMock = adapterType === MOCK_ADAPTER_TYPE
  const gatewayAccountId = isMock
    ? buildMockGatewayAccountId(row.id)
    : row.external_account_id
  if (!gatewayAccountId) return null
  return {
    accountId: Number(row.id),
    gatewayAccountId: String(gatewayAccountId),
    channel: row.channel,
    accountName: row.account_name,
    adapterType,
    isMock
  }
}

function createCloudGatewayAccountLoader({ sequelize: db = sequelize } = {}) {
  return async function loadCloudGatewayAccount(accountId) {
    const [rows] = await db.query(
      `SELECT id,channel,account_name,adapter_type,external_account_id
       FROM channel_accounts
       WHERE id = :accountId
         AND status = 'active'
         AND adapter_type IN (:adapterTypes)
       LIMIT 1`,
      {
        replacements: {
          accountId: Number(accountId),
          adapterTypes: [MOCK_ADAPTER_TYPE, WECOM_ADAPTER_TYPE]
        }
      }
    )
    return mapCloudGatewayAccount(rows[0])
  }
}

const findCloudGatewayAccountMapping = createCloudGatewayAccountLoader()

module.exports = {
  WECOM_ADAPTER_TYPE,
  createCloudGatewayAccountLoader,
  findCloudGatewayAccountMapping,
  mapCloudGatewayAccount
}
