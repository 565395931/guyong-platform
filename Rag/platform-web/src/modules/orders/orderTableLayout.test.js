import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const viewSource = readFileSync(new URL('../../views/Orders/OrdersView.vue', import.meta.url), 'utf8')

function columnOpeningTagContaining(needle) {
  const needleIndex = viewSource.indexOf(needle)
  assert.notEqual(needleIndex, -1, `expected OrdersView column area to contain ${needle}`)
  const tagStart = viewSource.lastIndexOf('<el-table-column', needleIndex)
  const tagEnd = viewSource.indexOf('>', tagStart)
  assert.notEqual(tagStart, -1, `expected ${needle} to be inside an el-table-column`)
  assert.notEqual(tagEnd, -1, `expected ${needle} column tag to close`)
  return viewSource.slice(tagStart, tagEnd + 1)
}

test('foreign tracking columns have room before the action column', () => {
  const internationalTrackingColumn = columnOpeningTagContaining('prop="international_tracking"')
  assert.match(internationalTrackingColumn, /:min-width=/)
  assert.doesNotMatch(internationalTrackingColumn, /\s:width=/)

  const actionColumn = columnOpeningTagContaining('class="operation-actions"')
  assert.doesNotMatch(actionColumn, /\sfixed=/)
})
