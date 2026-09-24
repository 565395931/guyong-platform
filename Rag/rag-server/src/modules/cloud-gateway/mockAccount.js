const { sequelize } = require('../../config/database')
const { ChannelAccount } = require('../../models')
const { encrypt } = require('../../shared/utils/encrypt')

const MOCK_ADAPTER_TYPE = 'cloud_gateway_mock'

function buildMockGatewayAccountId(accountId) {
  return `mock-account-${Number(accountId)}`
}

function mapMockAccount(row) {
  if (!row) return null
  return {
    accountId: Number(row.id),
    gatewayAccountId: buildMockGatewayAccountId(row.id),
    channel: row.channel,
    accountName: row.account_name,
    adapterType: row.adapter_type,
    isMock: true
  }
}

async function listMockChannels() {
  const [rows] = await sequelize.query(
    `SELECT code, label
     FROM channel_definitions
     WHERE status = 'active'
     ORDER BY sort_order, code`
  )
  return rows.map(row => ({ code: row.code, label: row.label }))
}

async function findMockAccountMapping(accountId) {
  const [rows] = await sequelize.query(
    `SELECT id, channel, account_name, adapter_type
     FROM channel_accounts
     WHERE id = :accountId
       AND status = 'active'
       AND adapter_type = :adapterType
     LIMIT 1`,
    { replacements: { accountId: Number(accountId), adapterType: MOCK_ADAPTER_TYPE } }
  )
  return mapMockAccount(rows[0])
}

async function ensureMockAccount(channel) {
  const normalizedChannel = String(channel || '').trim().toLowerCase()
  if (!/^[a-z0-9_-]{2,30}$/.test(normalizedChannel)) throw new Error('请选择有效的测试渠道')

  return sequelize.transaction(async transaction => {
    const [definitions] = await sequelize.query(
      `SELECT code, label, knowledge_scope, knowledge_channels
       FROM channel_definitions
       WHERE code = :channel AND status = 'active'
       LIMIT 1
       FOR UPDATE`,
      { replacements: { channel: normalizedChannel }, transaction }
    )
    const definition = definitions[0]
    if (!definition) throw new Error('测试渠道不存在或已停用')

    const [existingRows] = await sequelize.query(
      `SELECT id, channel, account_name, adapter_type
       FROM channel_accounts
       WHERE channel = :channel
         AND adapter_type = :adapterType
         AND status = 'active'
       ORDER BY id
       LIMIT 1`,
      { replacements: { channel: normalizedChannel, adapterType: MOCK_ADAPTER_TYPE }, transaction }
    )
    if (existingRows[0]) return { ...mapMockAccount(existingRows[0]), created: false }

    const knowledgeChannels = Array.isArray(definition.knowledge_channels)
      ? definition.knowledge_channels
      : [normalizedChannel]
    const account = await ChannelAccount.create({
      channel: normalizedChannel,
      account_name: `${definition.label} · 云网关 Mock`,
      config: encrypt({ mode: 'mock', externalConnection: false }),
      status: 'active',
      adapter_type: MOCK_ADAPTER_TYPE,
      max_daily_quota: 1000,
      knowledge_scope: definition.knowledge_scope || 'common',
      knowledge_channels: knowledgeChannels
    }, { transaction })

    return { ...mapMockAccount(account.get({ plain: true })), created: true }
  })
}

module.exports = {
  MOCK_ADAPTER_TYPE,
  buildMockGatewayAccountId,
  listMockChannels,
  findMockAccountMapping,
  ensureMockAccount
}
