// In-scope deployment smoke test, never writes credentials to stdout or files.
// Uses the existing local signing key and current active administrator, and
// performs operations via the normal role-checked local API, not direct SQL writes.
require('dotenv').config({ quiet: true })
const { execFileSync } = require('node:child_process')
const jwt = require('jsonwebtoken')
const { sequelize } = require('../src/config/database')
const { JWT_ISSUER, JWT_AUDIENCE } = require('../src/config/jwt')
async function main() {
  const [users] = await sequelize.query("SELECT id, username FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1")
  if (!users.length) throw new Error('no active local administrator')
  const token = jwt.sign({ id: users[0].id, username: users[0].username, role: 'admin' }, process.env.JWT_SECRET,
    { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '5m' })
  async function api(path, body) {
    const response = await fetch('http://127.0.0.1:3001/api/v1/' + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
    const data = await response.json()
    if (!response.ok || !data.success) throw new Error(data.message || 'local request failed')
    return data.data
  }
  if (process.argv.includes('--inspect-delete-plan')) {
    const { previewShopDeletion } = require('../src/modules/cloud-gateway/shopAccountDeletion')
    const [shops] = await sequelize.query("SELECT id, account_name FROM channel_accounts WHERE adapter_type = 'wechat_shop_cloud'")
    for (const shop of shops) {
      const counts = await previewShopDeletion(sequelize, shop.id)
      const preview = await api(`channel-accounts/${shop.id}/deletion-preview`)
      if (JSON.stringify(counts) !== JSON.stringify(preview.counts)) throw new Error('API deletion scope mismatch')
      console.log(JSON.stringify({ id: shop.id, name: shop.account_name, counts, apiPreviewVerified: true }))
    }
    if (!shops.length) {
      const { buildPlan } = require('../src/modules/cloud-gateway/shopAccountDeletion')
      const [columns] = await sequelize.query('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()')
      const [keys] = await sequelize.query('SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL')
      console.log(JSON.stringify({ shopCount: 0, deletionTables: buildPlan(columns, keys).map(row => row.table) }))
    }
    return
  }
  if (process.argv.includes('--inspect-delete')) {
    const [tables] = await sequelize.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('conversation_id', 'source_conversation_id', 'account_id', 'channel_account_id')")
    console.log(JSON.stringify(tables))
    const [foreignKeys] = await sequelize.query("SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN ('conversations', 'channel_accounts', 'plat_messages')")
    console.log(JSON.stringify({ foreignKeys }))
    for (const table of [...new Set(tables.map(row => row.TABLE_NAME))]) {
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error('invalid identifier')
      const conditions = tables.filter(row => row.TABLE_NAME === table).map(row => ['account_id', 'channel_account_id'].includes(row.COLUMN_NAME) ? `\`${row.COLUMN_NAME}\` = 1` : `\`${row.COLUMN_NAME}\` IN (SELECT id FROM conversations WHERE account_id = 1)`)
      const [counts] = await sequelize.query(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE ${conditions.join(' OR ')}`)
      if (Number(counts[0].count)) console.log(JSON.stringify({ table, count: counts[0].count }))
    }
    return
  }
  if (process.argv.includes('--delete-growth')) {
    const { createCredentialCipher } = require('../src/modules/platform-connections/credentialCipher')
    const cipher = createCredentialCipher()
    const [accounts] = await sequelize.query('SELECT * FROM channel_accounts WHERE id = 1')
    const account = accounts[0]
    if (!account || account.account_name !== '成长资料铺' || account.adapter_type !== 'wechat_shop_cloud') throw new Error('target account mismatch')
    const config = cipher.decrypt(account.config)
    if (config.gatewayAccountId !== '28bfac82-00c1-4f29-90ba-fb0086aeeaf3') throw new Error('target shop mismatch')
    const state = await api('local-workbench')
    const connection = state.find(row => row.id === config.clientId)
    if (connection && (connection.accounts.length !== 1 || Number(connection.accounts[0]) !== 1)) throw new Error('connection contains other shops')
    const [columns] = await sequelize.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('conversation_id', 'source_conversation_id', 'account_id', 'channel_account_id')")
    const chatTables = new Set(['plat_messages', 'conversation_pool_logs', 'ai_reply_logs', 'ai_suggest_qa_records', 'message_review_items', 'seat_account_bindings', 'channel_sync_state', 'channel_account_allowlists', 'channel_event_inbox', 'channel_operation_logs', 'customer_identities'])
    const predicates = new Map()
    for (const column of columns) {
      if (!/^[a-z0-9_]+$/.test(column.TABLE_NAME)) throw new Error('unexpected table identifier')
      if (column.TABLE_NAME === 'conversations') continue
      const condition = ['account_id', 'channel_account_id'].includes(column.COLUMN_NAME)
        ? `\`${column.COLUMN_NAME}\` = 1` : `\`${column.COLUMN_NAME}\` IN (SELECT id FROM conversations WHERE account_id = 1)`
      if (!predicates.has(column.TABLE_NAME)) predicates.set(column.TABLE_NAME, [])
      predicates.get(column.TABLE_NAME).push(condition)
    }
    for (const [table, conditions] of predicates) {
      if (chatTables.has(table)) continue
      const [rows] = await sequelize.query(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE ${conditions.join(' OR ')}`)
      if (Number(rows[0].count)) throw new Error(`associated business data exists in ${table}; no records deleted`)
    }
    if (connection) await api(`local-workbench/${config.clientId}/disconnect`, {})
    const transaction = await sequelize.transaction()
    try {
      const [locked] = await sequelize.query('SELECT * FROM channel_accounts WHERE id = 1 FOR UPDATE', { transaction })
      if (locked[0]?.status !== 'inactive' || locked[0]?.config !== account.config) throw new Error('account is not safely disconnected')
      const backup = { shopName: account.account_name, capturedAt: new Date().toISOString(), tables: { channel_accounts: locked } }
      const [conversations] = await sequelize.query('SELECT * FROM conversations WHERE account_id = 1 FOR UPDATE', { transaction })
      backup.tables.conversations = conversations
      for (const [table, conditions] of predicates) {
        if (!chatTables.has(table)) continue
        const [rows] = await sequelize.query(`SELECT * FROM \`${table}\` WHERE ${conditions.join(' OR ')} FOR UPDATE`, { transaction })
        backup.tables[table] = rows
      }
      const path = require('node:path')
      const fs = require('node:fs')
      const backupPath = path.resolve(__dirname, '../../logs', `growth-shop-delete-${Date.now()}.enc`)
      fs.writeFileSync(backupPath, cipher.encrypt(backup), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      for (const [table, conditions] of predicates) {
        if (chatTables.has(table)) await sequelize.query(`DELETE FROM \`${table}\` WHERE ${conditions.join(' OR ')}`, { transaction })
      }
      await sequelize.query('DELETE FROM conversations WHERE account_id = 1', { transaction })
      await sequelize.query('DELETE FROM channel_accounts WHERE id = 1', { transaction })
      await transaction.commit()
      console.log(JSON.stringify({ deletedShop: account.account_name, backupPath, deletedRows: Object.fromEntries(Object.entries(backup.tables).map(([name, rows]) => [name, rows.length])) }))
    } catch (error) { await transaction.rollback(); throw error }
    return
  }
  if (process.argv.includes('--request-restart')) {
    await api('system-control/restart-backend', {})
    console.log('backend restart requested'); return
  }
  if (process.argv.includes('--restart')) {
    const previous = await api('system-control/status')
    await api('system-control/restart-backend', {})
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try { const current = await api('system-control/status'); if (current.pid !== previous.pid) { console.log('local backend restarted'); return } } catch {}
    }
    throw new Error('backend restart timed out')
  }
  if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify(await api('local-workbench')))
    const [counts] = await sequelize.query("SELECT m.message_type, COUNT(*) AS count FROM plat_messages m JOIN conversations c ON c.id = m.conversation_id JOIN channel_accounts a ON a.id = c.account_id WHERE a.adapter_type = 'wechat_shop_cloud' GROUP BY m.message_type")
    console.log(JSON.stringify({ messageCounts: counts }))
    const [pools] = await sequelize.query("SELECT c.pool_type, c.conv_status, COUNT(*) AS count FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE a.adapter_type = 'wechat_shop_cloud' GROUP BY c.pool_type, c.conv_status")
    console.log(JSON.stringify({ conversationPools: pools }))
    const [images] = await sequelize.query("SELECT m.content FROM plat_messages m JOIN conversations c ON c.id = m.conversation_id JOIN channel_accounts a ON a.id = c.account_id WHERE a.adapter_type = 'wechat_shop_cloud' AND m.message_type = 'image' ORDER BY m.created_at DESC LIMIT 1")
    if (images.length) {
      const content = typeof images[0].content === 'string' ? JSON.parse(images[0].content) : images[0].content
      const path = content.url || content.imageUrl || content.image?.url
      if (typeof path === 'string' && path.startsWith('/api/v1/local-workbench/media/')) {
        const response = await fetch('http://127.0.0.1:3001' + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) })
        console.log(JSON.stringify({ imageStatus: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength }))
      } else console.log('image proxy path not found')
    }
    return
  }
  if (!process.argv.includes('--pair-growth')) {
    console.log(JSON.stringify(await api('local-workbench'))); return
  }
  const issued = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', 'root@121.196.214.206',
    'cd /opt/lonely-warrior/control-plane && node --env-file=/etc/lonely-warrior/control-plane.env scripts/issue-local-shop-pairing.js 28bfac82-00c1-4f29-90ba-fb0086aeeaf3'], { encoding: 'utf8', windowsHide: true }))
  if (issued.shopName !== '成长资料铺') throw new Error('shop name mismatch; refusing to pair')
  await api('local-workbench/pair', { code: issued.code })
  for (let attempt = 0; attempt < 15; attempt++) {
    const state = await api('local-workbench')
    if (state.some(row => row.state === 'connected' && row.shopNames.includes('成长资料铺'))) { console.log(JSON.stringify(state)); return }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('shop connection not ready')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => sequelize.close())
