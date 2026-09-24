<template>
  <aside
    class="app-sidebar"
    :class="{
      'app-sidebar--collapsed': sidebarCollapsed,
      'app-sidebar--mobile-open': mobileOpen
    }"
  >
    <div class="app-sidebar__header">
      <span class="app-sidebar__logo">◈</span>
      <span v-show="!sidebarCollapsed" class="app-sidebar__title">孤勇者</span>
    </div>
    <el-menu
      router
      :collapse="sidebarCollapsed"
      :default-active="activeMenu"
      class="app-sidebar__menu"
      background-color="transparent"
      text-color="#94a3b8"
      active-text-color="#60a5fa"
      @select="$emit('close-mobile')"
    >
      <template v-for="item in menuItems" :key="item.key">
        <template v-if="item.type === 'group'">
          <li v-show="!sidebarCollapsed" class="app-sidebar__section-label" role="presentation">
            <el-icon><component :is="iconComponents[item.icon]" /></el-icon>
            <span>{{ item.label }}</span>
            <button class="app-sidebar__section-toggle" type="button" :aria-label="`${item.label}${isExpanded(item.key) ? '收起' : '展开'}`" @click="toggleExpanded(item.key)">
              <el-icon><component :is="isExpanded(item.key) ? ArrowDown : ArrowRight" /></el-icon>
            </button>
          </li>
          <template v-if="isExpanded(item.key) || sidebarCollapsed">
            <template v-for="child in item.children" :key="child.key">
              <li v-if="child.children" class="app-sidebar__nested-toggle" :class="{ 'is-active': isNestedActive(child) }" role="presentation">
                <button type="button" :aria-label="`${child.label}${isExpanded(child.key) ? '收起' : '展开'}`" @click="toggleExpanded(child.key)">
                  <el-icon><component :is="iconComponents[child.icon]" /></el-icon>
                  <span class="app-sidebar__item-label">{{ child.label }}</span>
                  <el-icon class="app-sidebar__nested-arrow"><component :is="isExpanded(child.key) ? ArrowDown : ArrowRight" /></el-icon>
                </button>
              </li>
              <template v-if="child.children && isExpanded(child.key)">
                <el-menu-item
                  v-for="nested in child.children"
                  :key="nested.path"
                  class="app-sidebar__nested-item"
                  :class="{ 'is-active': isNestedRoute(nested.path) }"
                  :index="nested.path"
                  :title="sidebarCollapsed ? nested.label : ''"
                >
                  <el-icon><component :is="iconComponents[nested.icon]" /></el-icon>
                  <template #title><span class="app-sidebar__item-label">{{ nested.label }}</span></template>
                </el-menu-item>
              </template>
              <el-menu-item
                v-if="!child.children"
                :index="child.path"
                :title="sidebarCollapsed ? child.label : ''"
              >
                <el-icon><component :is="iconComponents[child.icon]" /></el-icon>
                <template #title>
                  <span class="app-sidebar__item-label">{{ child.label }}</span>
                  <el-badge
                    v-if="child.badge === 'review'"
                    class="app-sidebar__review-badge"
                    :value="formatReviewCount(reviewCount)"
                    :hidden="reviewCount === 0"
                  />
                </template>
              </el-menu-item>
            </template>
          </template>
        </template>
        <el-menu-item v-else :index="item.path">
          <el-icon><component :is="iconComponents[item.icon]" /></el-icon>
          <template #title>
            <span>{{ item.label }}</span>
          </template>
        </el-menu-item>
      </template>
    </el-menu>

    <div class="app-sidebar__footer">
      <button
        class="app-sidebar__btn"
        :title="settingsStore.darkMode ? '切换亮色' : '切换暗黑'"
        @click="settingsStore.toggleDarkMode()"
      >
        <el-icon v-if="settingsStore.darkMode"><Sunny /></el-icon>
        <el-icon v-else><Moon /></el-icon>
        <span v-show="!settingsStore.sidebarCollapsed" class="app-sidebar__btn-text">主题</span>
      </button>
      <button
        class="app-sidebar__btn"
        :title="sidebarCollapsed ? '展开菜单' : '收起菜单'"
        @click="settingsStore.toggleSidebar()"
      >
        <el-icon v-if="sidebarCollapsed"><Expand /></el-icon>
        <el-icon v-else><Fold /></el-icon>
        <span v-show="!sidebarCollapsed" class="app-sidebar__btn-text">收起</span>
      </button>
    </div>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  ChatDotRound, ChatLineRound, ChatRound, DataAnalysis, Promotion,
  VideoCamera, ShoppingCart, Goods, Connection, User, Tickets, Shop, Bell,
  Sunny, Moon, Expand, Fold, Warning, Setting, Headset, Briefcase, TrendCharts,
  Menu, ArrowDown, ArrowRight, UserFilled, Box
} from '@element-plus/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useUserStore } from '@/stores/user'
import { buildSidebarMenu } from '@/modules/navigation/channelNavigation'
import { createReviewCounter, formatReviewCount } from '@/modules/navigation/reviewCount'
import { getReviewStats } from '@/api/messageReviews'
import { websocketService } from '@/api/websocket'

const route = useRoute()
const settingsStore = useSettingsStore()
const userStore = useUserStore()
defineProps({ mobileOpen: { type: Boolean, default: false } })
defineEmits(['close-mobile'])
const isMobile = ref(false)
const mobileQuery = window.matchMedia('(max-width: 900px)')
const syncMobile = event => { isMobile.value = event.matches }
const reviewCounter = createReviewCounter({ fetchStats: getReviewStats, websocket: websocketService })
const reviewCount = reviewCounter.count
onMounted(() => {
  syncMobile(mobileQuery)
  mobileQuery.addEventListener('change', syncMobile)
  reviewCounter.start()
})
onBeforeUnmount(() => {
  mobileQuery.removeEventListener('change', syncMobile)
  reviewCounter.stop()
})
const sidebarCollapsed = computed(() => settingsStore.sidebarCollapsed && !isMobile.value)
const expandedKeys = ref(new Set())
const isExpanded = key => expandedKeys.value.has(key)
const toggleExpanded = key => {
  const next = new Set(expandedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedKeys.value = next
}
const isNestedActive = item => item.children?.some(child => route.fullPath === child.path || route.path === item.path)
const isNestedRoute = target => {
  const [path, search = ''] = target.split('?')
  if (route.path !== path) return false
  const targetChannel = new URLSearchParams(search).get('channel') || 'all'
  const routeChannel = String(route.query.channel || 'all')
  return targetChannel === routeChannel
}
const expandForRoute = path => {
  const next = new Set(expandedKeys.value)
  if (path === '/platform-messages') next.add('platform-messages')
  if (path === '/customer-service-accounts') next.add('customer-service-accounts')
  if (['/platform-messages', '/customer-service-accounts', '/message-reviews'].includes(path)) next.add('customer-work')
  if (path.startsWith('/statistics') || ['/campaigns', '/video', '/orders', '/catalog', '/warehouses', '/customers'].includes(path)) next.add('business-operations')
  if (path === '/settings/ai' || path === '/settings/accounts' || path === '/settings/video-data' || path === '/modules') next.add('system-settings')
  expandedKeys.value = next
}
watch(() => route.path, expandForRoute, { immediate: true })

const activeMenu = computed(() => {
  if (route.path === '/platform-messages' && !route.query.channel) return '/platform-messages?channel=all'
  if (route.path === '/customer-service-accounts' && !route.query.channel) return '/customer-service-accounts?channel=all'
  return route.fullPath
})
const iconComponents = {
  ChatDotRound,
  ChatLineRound,
  ChatRound,
  DataAnalysis,
  Promotion,
  VideoCamera,
  ShoppingCart,
  Goods,
  Connection,
  Shop,
  Bell,
  User,
  Tickets,
  Warning,
  Setting,
  Headset,
  Briefcase,
  TrendCharts,
  Menu,
  UserFilled,
  Box
}
const menuItems = computed(() => buildSidebarMenu(userStore.userInfo?.role))

</script>

<style lang="scss" scoped>
.app-sidebar {
  display: flex;
  flex-direction: column;
  width: 200px;
  height: 100%;
  background-color: #1e293b;
  transition: width 0.3s ease;
  flex-shrink: 0;
  overflow: hidden;

  &--collapsed {
    width: 64px;
  }

  &__header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 56px;
    padding: 0 20px;
    border-bottom: 1px solid #334155;
    flex-shrink: 0;
  }

  &__logo {
    font-size: 22px;
    color: #3b82f6;
    text-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
    flex-shrink: 0;
  }

  &__title {
    font-size: 15px;
    font-weight: 700;
    color: #e2e8f0;
    letter-spacing: 1px;
    white-space: nowrap;
  }

  &__menu {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    border-right: none;
    background-color: #1e293b;

    :deep(.el-menu-item) {
      height: 48px;
      line-height: 48px;

      .el-icon {
        font-size: 18px;
      }

      &:hover {
        background-color: rgba(59, 130, 246, 0.1) !important;
      }

    }

    :deep(.el-menu-item.is-active) {
      background-color: rgba(59, 130, 246, 0.15) !important;
      position: relative;

      &::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 1px;
        background: #3b82f6;
      }
    }

    // 折叠态居中
    &.el-menu--collapse {
      :deep(.el-menu-item) {
        display: flex;
        justify-content: center;
        padding: 0 !important;
      }
    }
  }

  &__section-label {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 8px 20px 2px;
    color: #64748b;
    font-size: 11px;
    font-weight: 600;
    line-height: 22px;

    .el-icon { font-size: 13px; }
  }

  &__section-toggle,
  &__nested-toggle button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  &__nested-toggle {
    height: 42px;
    padding: 0 20px 0 28px;
    color: #94a3b8;

    button { width: 100%; height: 100%; justify-content: flex-start; gap: 10px; }
    .el-icon { font-size: 16px; }
    .app-sidebar__nested-arrow { margin-left: auto; font-size: 12px; }
    &:hover, &.is-active { background: rgba(59, 130, 246, .08); color: #dbeafe; }
  }

  &__nested-item { padding-left: 48px !important; }

  &__item-label {
    flex: 1;
    min-width: 0;
  }

  &__review-badge {
    flex-shrink: 0;
    margin-left: auto;

    :deep(.el-badge__content) {
      position: static;
      transform: none;
      border: 0;
      background: #ef4444;
    }
  }

  &__footer {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border-top: 1px solid #334155;
  }

  &__btn {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 38px;
    padding: 0 12px;
    border: none;
    border-radius: 6px;
    background-color: transparent;
    color: #94a3b8;
    cursor: pointer;
    transition: background-color 0.2s, color 0.2s;

    .el-icon {
      font-size: 18px;
      flex-shrink: 0;
    }

    &:hover {
      background-color: #334155;
      color: #e2e8f0;
    }
  }

  &__btn-text {
    font-size: 13px;
    white-space: nowrap;
  }

  &--collapsed &__footer {
    align-items: center;

    .app-sidebar__btn {
      justify-content: center;
      padding: 0;
      width: 40px;
    }
  }
}

@media (max-width: 900px) {
  .app-sidebar {
    width: 220px;
    transform: translateX(-100%);
    box-shadow: 8px 0 24px rgba(15, 23, 42, .22);
    transition: transform .22s ease;

    &--collapsed { width: 220px; }
    &--mobile-open { transform: translateX(0); }

    &--collapsed :deep(.el-menu--collapse) { width: 220px; }
    &--collapsed .app-sidebar__title,
    &--collapsed .app-sidebar__btn-text { display: inline; }
    &--collapsed .app-sidebar__menu :deep(.el-menu-item) {
      justify-content: flex-start;
      padding: 0 20px !important;
    }
    &--collapsed .app-sidebar__nested-toggle {
      padding: 0;
      .app-sidebar__item-label,
      .app-sidebar__nested-arrow { display: none; }
      button { justify-content: center; }
    }
  }
}
</style>
