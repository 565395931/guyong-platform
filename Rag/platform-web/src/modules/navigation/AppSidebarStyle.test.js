import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../components/Layout/AppSidebar.vue', import.meta.url), 'utf8')

test('sidebar clips its contents and keeps the menu as the only scroll region', () => {
  assert.match(source, /\.app-sidebar\s*\{[\s\S]*?overflow:\s*hidden/)
  assert.match(source, /&__menu\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow-y:\s*auto/)
})

test('active background is scoped to menu items instead of submenu titles', () => {
  assert.match(source, /:deep\(\.el-menu-item\.is-active\)/)
  assert.doesNotMatch(source, /\.el-sub-menu__title\.is-active/)
})
