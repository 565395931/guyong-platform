import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('local shop delete is distinct, previews scope and requires exact name without dismissing pending request', () => {
  const dialog = source('../../views/Settings/components/ShopDeleteDialog.vue')
  const accounts = source('../../views/Settings/AccountManage.vue')
  assert.match(accounts, /wechat_shop_cloud' \? '删除店铺'/)
  assert.match(dialog, /await previewChannelAccountDeletion\(id\)/)
  assert.match(dialog, /confirmation.value !== props.account\?\.account_name/)
  assert.match(dialog, /await deleteChannelAccount\(id, \{ confirmName: confirmation.value \}\)/)
  assert.match(dialog, /:close-on-press-escape="!busy"/)
  assert.match(dialog, /store.current\?\.account_id/)
  assert.match(dialog, /远端店铺登记和原始消息保留/)
})

test('local DELETE transports confirmation in request body and allows cleanup timeout', () => {
  const api = source('../../api/channels.js')
  assert.match(api, /request.delete\([^\n]+\{ data, timeout: 60000 \}/)
})
