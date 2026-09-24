require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { sequelize } = require('../src/config/database')
const { encrypt } = require('../src/shared/utils/encrypt')
const { parseWahaAccountConfig } = require('../src/shared/utils/wahaConfig')

async function main() {
  const instances = JSON.parse(process.env.WAHA_INSTANCES || '[]')
  const byPort = new Map(instances.map(inst => [Number(inst.port), inst]))
  const [accounts] = await sequelize.query(
    `SELECT id, account_name, config FROM channel_accounts WHERE channel = 'whatsapp' AND status = 'active' ORDER BY id ASC`
  )

  const updates = []
  for (const account of accounts) {
    const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
    const port = Number(config.port)
    const inst = byPort.get(port)

    if (!inst) {
      updates.push({ id: account.id, port, updated: false, reason: 'no matching WAHA_INSTANCES port' })
      continue
    }

    const nextConfig = {
      ...config,
      wahaInstanceUrl: inst.host || config.wahaInstanceUrl,
      apiKey: inst.apiKey,
      port: inst.port,
      sessionName: config.sessionName || 'default'
    }

    await sequelize.query(
      `UPDATE channel_accounts SET config = :config, updated_at = NOW() WHERE id = :id`,
      { replacements: { id: account.id, config: encrypt(nextConfig) } }
    )

    updates.push({
      id: account.id,
      port: inst.port,
      host: inst.host,
      updated: true,
      apiKeyPrefix: inst.apiKey.slice(0, 12) + '...'
    })
  }

  console.log(JSON.stringify({ updatedAccounts: updates }, null, 2))
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await sequelize.close().catch(() => {})
  })
