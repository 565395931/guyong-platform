import test from 'node:test'
import assert from 'node:assert/strict'

async function loadDirectory() {
  const module = await import('./accountDirectory.js').catch(() => null)
  assert.ok(module, 'accountDirectory.js should exist')
  return module
}

test('keeps multiple accounts from the same platform as separate rows', async () => {
  const { normalizeAccountRows } = await loadDirectory()
  const rows = normalizeAccountRows([
    { id: 11, channel: 'whatsapp', account_name: 'WA Sales A', status: 'active' },
    { id: 12, channel: 'whatsapp', account_name: 'WA Sales B', status: 'active' }
  ])

  assert.deepEqual(rows.map(row => row.id), [11, 12])
  assert.deepEqual(rows.map(row => row.name), ['WA Sales A', 'WA Sales B'])
})

test('derives chat connection mode without inventing desktop node ids', async () => {
  const { getAccountConnectionMode, normalizeAccountRows } = await loadDirectory()
  const [whatsapp, taobao] = normalizeAccountRows([
    { id: 1, channel: 'whatsapp', account_name: 'WA' },
    { id: 2, channel: 'taobao', account_name: 'Store' }
  ])

  assert.equal(whatsapp.connectionMode, 'official_api')
  assert.equal(whatsapp.desktopNodeId, null)
  assert.equal(getAccountConnectionMode('wechat'), 'official_api')
  assert.equal(taobao.connectionMode, 'desktop_bridge_required')
  assert.equal(taobao.desktopNodeId, null)
})

test('filters accounts by channel without grouping or deduplication', async () => {
  const { filterAccountRows } = await loadDirectory()
  const rows = [
    { id: 1, channel: 'whatsapp' },
    { id: 2, channel: 'whatsapp' },
    { id: 3, channel: 'taobao' }
  ]

  assert.deepEqual(filterAccountRows(rows, 'whatsapp').map(row => row.id), [1, 2])
  assert.deepEqual(filterAccountRows(rows, '').map(row => row.id), [1, 2, 3])
})
