<template>
  <div class="app-layout">
    <button v-if="mobileMenuOpen" class="app-layout__backdrop" aria-label="关闭导航" @click="mobileMenuOpen = false" />
    <AppSidebar class="app-layout__sidebar" :mobile-open="mobileMenuOpen" @close-mobile="mobileMenuOpen = false" />
    <div class="app-layout__right">
      <AppHeader
        class="app-layout__header"
        @toggle-mobile-menu="mobileMenuOpen = !mobileMenuOpen"
        @open-desktop-settings="openDesktopSettings"
      />
      <div class="app-layout__content">
        <router-view />
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppSidebar from './AppSidebar.vue'
import AppHeader from './AppHeader.vue'
import { useUserStore } from '@/stores/user'
import { useConversationStore } from '@/stores/conversation'
import { websocketService } from '@/api/websocket'
import { messageReminder } from '@/utils/messageReminder'

const userStore = useUserStore()
const conversationStore = useConversationStore()
const route = useRoute()
const mobileMenuOpen = ref(false)
const openDesktopSettings = inject('openDesktopSettings', () => {})

watch(() => route.fullPath, () => { mobileMenuOpen.value = false })

// 建立 WebSocket 连接
function connectWebSocket() {
  if (userStore.token) {
    websocketService.connect(userStore.token)
  }
}

// 监听 token 变化：登录后连接，退出时断开
watch(
  () => userStore.token,
  (newToken, oldToken) => {
    if (newToken && !oldToken) {
      // 登录成功，建立连接
      connectWebSocket()
    } else if (!newToken && oldToken) {
      // 退出登录，断开连接
      websocketService.disconnect()
    }
  }
)

watch(
  () => conversationStore.unreadTotal,
  (count) => {
    messageReminder.setUnreadCount(count)
  },
  { immediate: true }
)

onMounted(() => {
  messageReminder.init()
  // 已登录状态进入页面时直接连接
  connectWebSocket()
})

onBeforeUnmount(() => {
  websocketService.disconnect()
})
</script>

<style lang="scss" scoped>
.app-layout {
  display: flex;
  width: 100%;
  height: 100%;

  &__sidebar {
    flex-shrink: 0;
  }

  &__backdrop { display: none; }

  &__right {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }

  &__header {
    flex-shrink: 0;
  }

  &__content {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
}

@media (max-width: 900px) {
  .app-layout {
    &__sidebar {
      position: fixed;
      z-index: 1200;
      inset: 0 auto 0 0;
    }

    &__backdrop {
      display: block;
      position: fixed;
      z-index: 1190;
      inset: 0;
      width: 100%;
      border: 0;
      background: rgba(15, 23, 42, .42);
    }

    &__right { width: 100%; }
  }
}
</style>
