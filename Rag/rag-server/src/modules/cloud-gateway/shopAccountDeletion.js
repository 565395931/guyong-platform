const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const parents = { account_id: 'channel_accounts', channel_account_id: 'channel_accounts', conversation_id: 'conversations', source_conversation_id: 'conversations', order_id: 'orders', quote_id: 'quote_records', fulfillment_id: 'order_fulfillments', message_id: 'plat_messages', source_message_id: 'plat_messages', identity_id: 'customer_identities' }
const ident = value => { if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('Unsupported database identifier'); return '`' + value + '`' }

// Metadata-only discovery. No shared customer/user/catalog master row is selected.
function buildPlan(columns, foreignKeys = []) {
  const tables = new Map()
  for (const row of columns) {
    ident(row.TABLE_NAME); ident(row.COLUMN_NAME)
    if (!tables.has(row.TABLE_NAME)) tables.set(row.TABLE_NAME, [])
    tables.get(row.TABLE_NAME).push(row.COLUMN_NAME)
  }
  const plan = new Map([['channel_accounts', { where: 'id = :accountId', dependencies: [] }]])
  for (const [table, names] of tables) {
    if (table === 'channel_accounts') continue
    const scope = names.filter(name => ['account_id', 'channel_account_id'].includes(name)).map(name => `${ident(name)} = :accountId`)
    if (scope.length) plan.set(table, { where: scope.join(' OR '), dependencies: [] })
  }
  const edges = foreignKeys.map(row => ({ table: row.TABLE_NAME, column: row.COLUMN_NAME, parent: row.REFERENCED_TABLE_NAME, parentColumn: row.REFERENCED_COLUMN_NAME }))
  for (const [table, names] of tables) for (const name of names) {
    if (parents[name] && table !== parents[name]) edges.push({ table, column: name, parent: parents[name], parentColumn: 'id' })
  }
  // Each edge is incorporated once. Recursive/cyclic ownership is rejected rather than guessed.
  const applied = new Set()
  for (let pass = 0; pass < tables.size; pass++) {
    let changed = false
    for (const edge of edges) {
      const key = JSON.stringify(edge)
      if (applied.has(key) || !plan.has(edge.parent) || edge.table === edge.parent || edge.table === 'channel_accounts') continue
      const reaches = (table, target, seen = new Set()) => {
        if (table === target) return true
        if (seen.has(table)) return false
        seen.add(table); return (plan.get(table)?.dependencies || []).some(next => reaches(next, target, seen))
      }
      if (reaches(edge.parent, edge.table)) throw new Error('Unsupported cyclic shop data relationship')
      const current = plan.get(edge.table)
      plan.set(edge.table, { where: current?.where || '', edges: [...(current?.edges || []), edge], dependencies: [...new Set([...(current?.dependencies || []), edge.parent])] })
      applied.add(key); changed = true
    }
    if (!changed) break
  }
  const ordered = [], visited = new Set()
  function visit(table) {
    if (visited.has(table)) return
    visited.add(table)
    for (const child of plan.keys()) if (plan.get(child).dependencies.includes(table)) visit(child)
    ordered.push(table)
  }
  for (const table of plan.keys()) visit(table)
  const render = table => {
    const item = plan.get(table)
    const terms = [item.where, ...(item.edges || []).map(edge => `${ident(edge.column)} IN (SELECT ${ident(edge.parentColumn)} FROM ${ident(edge.parent)} WHERE ${render(edge.parent)})`)].filter(Boolean)
    return terms.map(term => '(' + term + ')').join(' OR ')
  }
  return ordered.map(table => ({ table, ...plan.get(table), where: render(table) }))
}

async function schema(sequelize, transaction) {
  const [columns] = await sequelize.query('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()', { transaction })
  const [keys] = await sequelize.query('SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL', { transaction })
  return { columns, plan: buildPlan(columns, keys) }
}

async function previewShopDeletion(sequelize, accountId) {
  const { plan } = await schema(sequelize)
  const counts = {}
  for (const item of plan) {
    const [rows] = await sequelize.query(`SELECT COUNT(*) AS count FROM ${ident(item.table)} WHERE ${item.where}`, { replacements: { accountId } })
    if (Number(rows[0].count)) counts[item.table] = Number(rows[0].count)
  }
  return counts
}

async function deleteShopAccount({ sequelize, account, manager, confirmation, backupDirectory = path.resolve(__dirname, '../../../..', 'logs') }) {
  if (confirmation !== account.account_name) throw Object.assign(new Error('请输入完整店铺名称确认删除'), { status: 400 })
  if (manager.busy) throw Object.assign(new Error('连接配置正在处理，请稍后删除'), { status: 409 })
  manager.busy = true
  try {
    await manager.detachAccount(account)
    return await sequelize.transaction(async transaction => {
      const [locked] = await sequelize.query('SELECT * FROM channel_accounts WHERE id = :accountId FOR UPDATE', { replacements: { accountId: account.id }, transaction })
      if (!locked.length) return { alreadyDeleted: true }
      if (locked[0].adapter_type !== 'wechat_shop_cloud' || locked[0].account_name !== confirmation || locked[0].config !== account.config || locked[0].status !== 'inactive') throw new Error('店铺配置已变化，请重新确认')
      const { columns, plan } = await schema(sequelize, transaction)
      const snapshots = {}, primary = {}
      for (const item of plan) {
        const [rows] = await sequelize.query(`SELECT * FROM ${ident(item.table)} WHERE ${item.where} FOR UPDATE`, { replacements: { accountId: account.id }, transaction })
        snapshots[item.table] = rows
        primary[item.table] = columns.filter(row => row.TABLE_NAME === item.table && row.COLUMN_KEY === 'PRI').map(row => row.COLUMN_NAME)
        if (rows.length && !primary[item.table].length) throw new Error('关联数据缺少主键，删除已停止')
      }
      const backupPath = path.join(backupDirectory, `shop-delete-${crypto.randomUUID()}.enc`)
      fs.mkdirSync(path.dirname(backupPath), { recursive: true })
      fs.writeFileSync(backupPath, manager.encrypt({ capturedAt: new Date().toISOString(), accountId: account.id, tables: snapshots }), { flag: 'wx', mode: 0o600 })
      for (const item of plan) {
        const keys = primary[item.table]
        for (let offset = 0; offset < snapshots[item.table].length; offset += 100) {
          const replacements = {}
          const where = snapshots[item.table].slice(offset, offset + 100).map((row, index) => '(' + keys.map((key, n) => { const parameter = `p${index}_${n}`; replacements[parameter] = row[key]; return `${ident(key)} = :${parameter}` }).join(' AND ') + ')').join(' OR ')
          await sequelize.query(`DELETE FROM ${ident(item.table)} WHERE ${where}`, { replacements, transaction })
        }
      }
      return { deleted: Object.fromEntries(Object.entries(snapshots).map(([table, rows]) => [table, rows.length])) }
    })
  } finally { try { await manager.restore() } finally { manager.busy = false } }
}

module.exports = { buildPlan, previewShopDeletion, deleteShopAccount }
