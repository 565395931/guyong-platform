import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('sidebar shows the per-channel pending count next to the channel entry', () => {
  const source = readSource('../../components/Layout/AppSidebar.vue')

  // 待人工数量挂在渠道条目右边（「抖店」这类），来源是池统计里的按渠道计数
  assert.match(source, /class="app-sidebar__pending-badge"/)
  assert.match(source, /pendingCountFor\(nested\.path\)/)
  assert.match(source, /conversationStore\.poolStats\?\.pendingByChannel\?\.\[channel\]/)
  assert.match(source, /child\.key === 'platform-messages'/)
})

test('sidebar blinks red for a channel that cannot connect', () => {
  const source = readSource('../../components/Layout/AppSidebar.vue')

  assert.match(source, /'app-sidebar__nested-item--alert': isChannelAbnormalFor\(nested\.path\)/)
  assert.match(source, /isChannelAbnormalFor = target => channelHealth\.isChannelAbnormal\(channelOfMenuPath\(target\)\)/)
  // 动画不能只靠颜色，色觉差异也要能看出变化
  assert.match(source, /@keyframes app-sidebar-channel-alert/)
})

test('account manage shows the channel alert even when embedded in the workbench', () => {
  const source = readSource('../../views/Settings/AccountManage.vue')

  // 工作台里的账号管理是嵌入渲染的（account-manage-view--embedded），
  // 横幅必须放在 v-if="!props.embedded" 的筛选条**之外**，否则等于不显示（实测踩过）
  const bannerIndex = source.indexOf('account-manage-view__channel-alert')
  const headerIndex = source.indexOf('class="account-manage-view__header"')
  assert.ok(bannerIndex > -1 && headerIndex > -1)
  assert.ok(bannerIndex < headerIndex, '渠道异常横幅必须出现在嵌入判断之前')
  assert.match(source, /v-if="abnormalChannelInScope"/)
  assert.match(source, /@keyframes account-channel-alert/)
})

test('channel health is shared and refreshed on every mount', () => {
  const source = readSource('../../modules/channels/channelHealth.js')

  assert.match(source, /const ABNORMAL_STATUSES = new Set\(\['OFFLINE', 'CRITICAL', 'UNKNOWN', 'PARTIAL'\]\)/)
  // 第二个组件挂载时定时器已存在，早退会显示最多 60 秒的陈旧状态
  assert.match(source, /fetchChannelHealth\(\)\n  if \(timer\) return/)
})
