require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const axios = require('axios')
const { sequelize } = require('../src/config/database')
const { parseWahaAccountConfig } = require('../src/shared/utils/wahaConfig')

const conversationId = process.argv[2]

async function checkWaha(host, apiKey, label) {
  try {
    const client = axios.create({
      baseURL: host,
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      timeout: 8000
    })
    const res = await client.get('/api/sessions')
    return {
      label,
      host,
      keyPrefix: apiKey ? apiKey.slice(0, 12) + '...' : '(empty)',
      ok: true,
      status: res.status,
      sessions: Array.isArray(res.data) ? res.data.map(s => ({ name: s.name || s.Name, status: s.status || s.Status })) : res.data
    }
  } catch (err) {
    return {
      label,
      host,
      keyPrefix: apiKey ? apiKey.slice(0, 12) + '...' : '(empty)',
      ok: false,
      status: err.response?.status || err.code,
      error: err.response?.data?.message || err.response?.data?.error || err.message
    }
  }
}

async function main() {
  const report = {
    env: {
      WAHA_API_URL: process.env.WAHA_API_URL,
      WAHA_API_KEY_prefix: process.env.WAHA_API_KEY ? process.env.WAHA_API_KEY.slice(0, 12) + '...' : '(empty)',
      WAHA_INSTANCES: []
    },
    conversation: null,
    accounts: [],
    checks: []
  }

  try {
    report.env.WAHA_INSTANCES = JSON.parse(process.env.WAHA_INSTANCES || '[]').map(i => ({
      port: i.port,
      host: i.host,
      apiKeyPrefix: i.apiKey ? i.apiKey.slice(0, 12) + '...' : '(empty)'
    }))
  } catch (err) {
    report.env.WAHA_INSTANCES_parse_error = err.message
  }

  if (conversationId) {
    const [rows] = await sequelize.query(
      `SELECT id, channel, account_id, user_id FROM conversations WHERE id = :id`,
      { replacements: { id: conversationId } }
    )
    report.conversation = rows[0] || null
  }

  const [accounts] = await sequelize.query(
    `SELECT id, account_name, channel, status, config FROM channel_accounts WHERE channel = 'whatsapp' ORDER BY id ASC`
  )

  for (const account of accounts) {
    const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
    report.accounts.push({
      id: account.id,
      account_name: account.account_name,
      status: account.status,
      wahaInstanceUrl: config.wahaInstanceUrl || null,
      port: config.port || null,
      sessionName: config.sessionName || null,
      apiKeyPrefix: config.apiKey ? config.apiKey.slice(0, 12) + '...' : '(empty)'
    })

    if (account.status === 'active' && config.wahaInstanceUrl) {
      report.checks.push(await checkWaha(config.wahaInstanceUrl, config.apiKey || '', `account:${account.id}`))
    }
  }

  if (process.env.WAHA_API_URL) {
    report.checks.push(await checkWaha(process.env.WAHA_API_URL, process.env.WAHA_API_KEY || '', 'env:fallback'))
  }

  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await sequelize.close().catch(() => {})
  })
