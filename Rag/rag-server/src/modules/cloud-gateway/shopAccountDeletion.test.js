const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildPlan, deleteShopAccount } = require('./shopAccountDeletion')
const { createCredentialCipher } = require('../platform-connections/credentialCipher')

const columns = Object.entries({ channel_accounts: ['id'], conversations: ['id', 'account_id'], plat_messages: ['id', 'conversation_id'], orders: ['id', 'source_conversation_id'], order_lines: ['id', 'order_id'], customer_identities: ['id', 'account_id'], identity_logs: ['id', 'identity_id'], customers: ['id'], users: ['id'] })
  .flatMap(([TABLE_NAME, names]) => names.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME, COLUMN_KEY: COLUMN_NAME === 'id' ? 'PRI' : '' })))

test('deletion plan follows only scoped descendants and orders children before parents', () => {
  const plan = buildPlan(columns)
  assert.equal(plan.some(row => ['customers', 'users'].includes(row.table)), false)
  assert.ok(plan.findIndex(row => row.table === 'order_lines') < plan.findIndex(row => row.table === 'orders'))
  assert.ok(plan.findIndex(row => row.table === 'orders') < plan.findIndex(row => row.table === 'conversations'))
  assert.match(plan.find(row => row.table === 'order_lines').where, /:accountId/)
  assert.equal(plan.at(-1).table, 'channel_accounts')
})

test('plan incorporates final parent scopes and rejects cyclic ownership and unsafe names', () => {
  const extra = [...columns, { TABLE_NAME: 'orders', COLUMN_NAME: 'account_id' }]
  assert.match(buildPlan(extra).find(row => row.table === 'order_lines').where, /`account_id` = :accountId/)
  assert.throws(() => buildPlan(columns, [{ TABLE_NAME: 'conversations', COLUMN_NAME: 'last_message_id', REFERENCED_TABLE_NAME: 'plat_messages', REFERENCED_COLUMN_NAME: 'id' }]), /cyclic/)
  assert.throws(() => buildPlan([{ TABLE_NAME: 'invalid-table', COLUMN_NAME: 'account_id' }]), /identifier/)
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-shop-delete-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const account = { id: 7, account_name: '目标店铺', adapter_type: 'wechat_shop_cloud', config: 'encrypted-fixture', status: 'active' }
  const target = { channel_accounts: [{ ...account }], conversations: [{ id: 10, account_id: 7 }], plat_messages: [{ id: 20, conversation_id: 10, text: 'private-fixture-text' }], orders: [], order_lines: [], customer_identities: [], identity_logs: [] }
  const other = { channel_accounts: [{ id: 8 }], conversations: [{ id: 11, account_id: 8 }], plat_messages: [{ id: 21, conversation_id: 11 }], customers: [{ id: 55 }] }
  const deletes = [], cipher = createCredentialCipher({ key: Buffer.alloc(32, 9).toString('base64') })
  const manager = { ...cipher, busy: false, detached: 0, restored: 0, async detachAccount() { this.detached++; target.channel_accounts[0].status = 'inactive' }, async restore() { this.restored++ } }
  const sequelize = {
    async transaction(fn) {
      const snapshot = structuredClone(target)
      try { return await fn({}) } catch (error) { Object.assign(target, snapshot); throw error }
    },
    async query(sql, options) {
      if (sql.includes('information_schema.COLUMNS')) return [columns]
      if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [[]]
      if (sql.startsWith('SELECT * FROM channel_accounts')) return [target.channel_accounts]
      if (sql.startsWith('SELECT *')) { const table = sql.match(/FROM `([a-z_]+)`/)[1]; assert.equal(options.replacements.accountId, 7); return [structuredClone(target[table])] }
      if (sql.startsWith('DELETE')) {
        const table = sql.match(/FROM `([a-z_]+)`/)[1]; deletes.push(table)
        if (sequelize.failDelete) throw new Error('fixture delete failed')
        const ids = Object.values(options.replacements)
        target[table] = target[table].filter(row => !ids.includes(row.id)); return [[]]
      }
      throw new Error('Unexpected fixture query')
    }
  }
  return { account, manager, sequelize, backupDirectory: directory, target, other, deletes }
}

test('name confirmation or busy guard makes no connection/database changes', async t => {
  const f = fixture(t)
  await assert.rejects(deleteShopAccount({ ...f, confirmation: '错误店铺' }), { status: 400 })
  f.manager.busy = true
  await assert.rejects(deleteShopAccount({ ...f, confirmation: f.account.account_name }), { status: 409 })
  assert.equal(f.manager.detached, 0); assert.deepEqual(f.deletes, [])
})

test('confirmed deletion takes encrypted backup and deletes child rows before account; other shop remains', async t => {
  const f = fixture(t), before = structuredClone(f.other)
  const result = await deleteShopAccount({ ...f, confirmation: f.account.account_name })
  assert.equal(result.deleted.plat_messages, 1)
  assert.deepEqual(f.deletes, ['plat_messages', 'conversations', 'channel_accounts'])
  assert.equal(f.target.channel_accounts.length, 0); assert.deepEqual(f.other, before)
  assert.equal(f.manager.restored, 1); assert.equal(f.manager.busy, false)
  const backup = fs.readFileSync(path.join(f.backupDirectory, fs.readdirSync(f.backupDirectory)[0]), 'utf8')
  assert.equal(backup.includes('private-fixture-text'), false)
  assert.equal(f.manager.decrypt(backup).tables.plat_messages[0].text, 'private-fixture-text')
})

test('backup failure deletes nothing; transaction failure rolls database rows back', async t => {
  const f = fixture(t)
  f.manager.encrypt = () => { throw new Error('backup unavailable') }
  await assert.rejects(deleteShopAccount({ ...f, confirmation: f.account.account_name }), /backup unavailable/)
  assert.deepEqual(f.deletes, []); assert.equal(f.target.plat_messages.length, 1)
  const second = fixture(t); second.sequelize.failDelete = true
  await assert.rejects(deleteShopAccount({ ...second, confirmation: second.account.account_name }), /fixture delete failed/)
  assert.equal(second.target.channel_accounts.length, 1); assert.equal(second.target.plat_messages.length, 1)
  assert.equal(second.manager.busy, false); assert.equal(second.manager.restored, 1)
})
