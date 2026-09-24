import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('warehouse workspace exposes a filterable and paginated inventory ledger', () => {
  const panel = readFileSync(fileURLToPath(new URL('./WarehouseLedgerPanel.vue', import.meta.url)), 'utf8')
  const view = readFileSync(fileURLToPath(new URL('./WarehouseView.vue', import.meta.url)), 'utf8')
  assert.match(panel, /getWarehouseLedger/)
  assert.match(panel, /operationType/)
  assert.match(panel, /el-pagination/)
  assert.match(panel, /page-sizes="\[20, 50, 100\]"/)
  assert.match(panel, /createdBy/)
  assert.match(view, /WarehouseLedgerPanel/)
})
