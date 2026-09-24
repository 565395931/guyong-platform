require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const axios = require('axios')
const { sequelize } = require('../src/config/database')
const { parseWahaAccountConfig } = require('../src/shared/utils/wahaConfig')

function isSessionConnected(status) {
  return status === 'CONNECTED' || status === 'WORKING'
}

function extractAccountInfoFromSession(session) {
  if (!session || !session.me) {
    return { phoneNumber: null, whatsappName: null }
  }

  const me = session.me
  let phoneNumber = null
  if (me.id) {
    phoneNumber = String(me.id).replace(/@.*$/, '')
  } else if (me.wid) {
    phoneNumber = String(me.wid).replace(/@.*$/, '')
  }

  return {
    phoneNumber,
    whatsappName: me.pushName || me.name || me.PushName || null
  }
}

async function fetchSessionInfo(host, apiKey) {
  const client = axios.create({
    baseURL: host,
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  })

  const response = await client.get('/api/sessions')
  const sessions = Array.isArray(response.data)
    ? response.data
    : [response.data].filter(Boolean)

  return sessions[0] || null
}

async function updateAccountProfile(id, phoneNumber, whatsappName) {
  await sequelize.query(
    `UPDATE channel_accounts
        SET phone_number = :phone_number,
            whatsapp_name = :whatsapp_name,
            updated_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        id,
        phone_number: phoneNumber,
        whatsapp_name: whatsappName
      }
    }
  )
}

async function main() {
  const clearDisconnected = !process.argv.includes('--keep-disconnected')

  const [accounts] = await sequelize.query(
    `SELECT id, account_name, status, config, phone_number, whatsapp_name
       FROM channel_accounts
      WHERE channel = 'whatsapp' AND status = 'active'
      ORDER BY id ASC`
  )

  const results = []

  for (const account of accounts) {
    const config = parseWahaAccountConfig(account.config, `accountId=${account.id}`)
    const host = config.wahaInstanceUrl || config.host || (config.port ? `http://localhost:${config.port}` : null)
    const apiKey = config.apiKey || ''

    if (!host) {
      results.push({
        id: account.id,
        account_name: account.account_name,
        action: 'skip',
        reason: 'missing host config'
      })
      continue
    }

    try {
      const session = await fetchSessionInfo(host, apiKey)
      const rawStatus = session?.status || session?.Status || 'NO_SESSION'

      if (session && isSessionConnected(rawStatus)) {
        const phoneInfo = extractAccountInfoFromSession(session)
        await updateAccountProfile(account.id, phoneInfo.phoneNumber, phoneInfo.whatsappName)
        results.push({
          id: account.id,
          account_name: account.account_name,
          action: 'sync',
          port: config.port || null,
          status: rawStatus,
          before: {
            phone_number: account.phone_number || null,
            whatsapp_name: account.whatsapp_name || null
          },
          after: {
            phone_number: phoneInfo.phoneNumber,
            whatsapp_name: phoneInfo.whatsappName
          }
        })
        continue
      }

      if (clearDisconnected) {
        await updateAccountProfile(account.id, null, null)
      }

      results.push({
        id: account.id,
        account_name: account.account_name,
        action: clearDisconnected ? 'clear' : 'keep',
        port: config.port || null,
        status: rawStatus,
        before: {
          phone_number: account.phone_number || null,
          whatsapp_name: account.whatsapp_name || null
        },
        after: {
          phone_number: clearDisconnected ? null : (account.phone_number || null),
          whatsapp_name: clearDisconnected ? null : (account.whatsapp_name || null)
        }
      })
    } catch (err) {
      results.push({
        id: account.id,
        account_name: account.account_name,
        action: 'error',
        port: config.port || null,
        reason: err.response?.data?.message || err.response?.data?.error || err.message,
        status: err.response?.status || err.code || 'UNKNOWN'
      })
    }
  }

  console.log(JSON.stringify({ clearDisconnected, results }, null, 2))
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await sequelize.close().catch(() => {})
  })
