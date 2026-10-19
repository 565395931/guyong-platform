import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

// 快捷话术面板曾经整棵树都写死在组件里（个人话术/开场白/您好…），点了没反应，
// 也没有任何接口调用。这些断言守住"接真实接口 + 四个交互都在"这件事。
test('quick reply panel loads replies from the API instead of hardcoded data', () => {
  const source = readSource('../../components/Panel/QuickReplyPanel.vue')

  assert.match(source, /getQuickReplies\(\{ page, pageSize: 100 \}\)/)
  assert.doesNotMatch(source, /id:\s*111/)
  assert.doesNotMatch(source, /const treeData = ref\(\[/)
})

test('quick reply panel exposes copy, edit, add and delete affordances', () => {
  const source = readSource('../../components/Panel/QuickReplyPanel.vue')

  // 点击复制：leaf 才复制，并且要带局域网 http 下的兜底（navigator.clipboard 只在 https/localhost 可用）
  assert.match(source, /if \(data\.kind !== 'item'\) return/)
  assert.match(source, /window\.isSecureContext/)
  assert.match(source, /document\.execCommand\('copy'\)/)
  // 每条话术：编辑 + 删除
  assert.match(source, /title="编辑我的话术"/)
  // 每一层分组 / 分类：添加 + 删除
  assert.match(source, /v-if="data\.kind !== 'item'"/)
  assert.match(source, /title="添加个人话术"/)
  // 删除分级：单条走 id，整层走收集子节点
  assert.match(source, /const collectReplies = \(node\) =>/)
})

test('quick reply panel calls the CRUD endpoints and gates them by role', () => {
  const panel = readSource('../../components/Panel/QuickReplyPanel.vue')
  const api = readSource('../../api/messages.js')

  assert.match(panel, /createQuickReply\(payload\)/)
  assert.match(panel, /updateQuickReply\(form\.value\.id, payload\)/)
  assert.match(panel, /deleteQuickReply\(r\.id\)/)
  // 后端 requireManager 只放 admin / 主管，坐席点上去只会 403，所以按钮也不该给
  assert.match(panel, /\['admin', 'agent'\]\.includes\(userStore\.userInfo\?\.role\)/)

  assert.match(api, /export function createQuickReply/)
  assert.match(api, /export function updateQuickReply/)
  assert.match(api, /export function deleteQuickReply/)
})
