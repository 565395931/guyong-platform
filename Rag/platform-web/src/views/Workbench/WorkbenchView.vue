<template>
  <div class="workbench-view" :class="{ 'workbench-view--embedded': props.embedded }">
    <!-- 左栏：会话列表 -->
    <div
      class="workbench-view__left"
      :class="{ 'workbench-view__left--collapsed': settingsStore.leftCollapsed }"
    >
      <div class="workbench-view__panel-header">
        <span class="workbench-view__panel-title">
          <el-icon><ChatDotRound /></el-icon>
          {{ channelScope.fixedChannel ? `${channelScope.label}会话` : '会话列表' }}
        </span>
        <el-button
          text
          :icon="settingsStore.leftCollapsed ? Expand : Fold"
          @click="settingsStore.toggleLeft"
        />
      </div>
      <div v-show="!settingsStore.leftCollapsed" class="workbench-view__left-body">
          <ConversationList
            :fixed-channel="channelScope.fixedChannel"
            :channel-label="channelScope.label"
            :account-id="props.accountId"
          />
      </div>
    </div>

    <!-- 左栏收起时的展开按钮 -->
    <div
      v-if="settingsStore.leftCollapsed"
      class="workbench-view__side-handle workbench-view__side-handle--left"
      @click="settingsStore.toggleLeft"
    >
      <el-icon><Expand /></el-icon>
    </div>

    <!-- 中栏：聊天窗口 -->
    <div class="workbench-view__center">
      <ChatWindow
        v-if="conversationStore.current"
        :conversation="conversationStore.current"
        :read-only-channels="props.readOnlyChannels"
        :read-only-reason="props.readOnlyReason"
      />
      <div v-else class="workbench-view__empty">
        <el-empty description="请从左侧选择一个会话开始接待">
          <template #image>
            <el-icon :size="80" color="#dcdfe6"><ChatLineSquare /></el-icon>
          </template>
        </el-empty>
      </div>
    </div>

    <!-- 右栏：用户信息 + RAG + 快捷话术 -->
    <div
      class="workbench-view__right"
      :class="{ 'workbench-view__right--collapsed': settingsStore.rightCollapsed }"
    >
      <div class="workbench-view__panel-header">
        <span class="workbench-view__panel-title">
          <el-icon><Operation /></el-icon>
          辅助面板
        </span>
        <el-button
          text
          :icon="settingsStore.rightCollapsed ? Fold : Expand"
          @click="settingsStore.toggleRight"
        />
      </div>
      <div v-show="!settingsStore.rightCollapsed" class="workbench-view__right-body">
        <el-tabs v-model="activeTab" class="workbench-view__tabs">
          <el-tab-pane label="用户信息" name="info">
            <UserInfoCard
              v-if="conversationStore.current"
              :conversation="conversationStore.current"
              @avatar-updated="onAvatarUpdated"
              @nationality-updated="onNationalityUpdated"
            />
            <el-empty v-else description="未选择会话" :image-size="60" />
          </el-tab-pane>
          <el-tab-pane label="快捷话术" name="quick">
            <QuickReplyPanel v-if="conversationStore.current" :conversation="conversationStore.current" />
            <el-empty v-else description="未选择会话" :image-size="60" />
          </el-tab-pane>
          <!-- 文件选择已迁移到输入框下方 -->
        </el-tabs>
      </div>
    </div>

    <!-- 右栏收起时的展开按钮 -->
    <div
      v-if="settingsStore.rightCollapsed"
      class="workbench-view__side-handle workbench-view__side-handle--right"
      @click="settingsStore.toggleRight"
    >
      <el-icon><Fold /></el-icon>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  ChatDotRound,
  ChatLineSquare,
  Operation,
  Fold,
  Expand
} from '@element-plus/icons-vue'
import { useConversationStore } from '@/stores/conversation'
import { useSettingsStore } from '@/stores/settings'
import { useUserStore } from '@/stores/user'
import { websocketService } from '@/api/websocket'
import { updateSeatStatus } from '@/api/conversations'
import ConversationList from '@/components/Conversation/ConversationList.vue'
import ChatWindow from '@/components/Chat/ChatWindow.vue'
import UserInfoCard from '@/components/Panel/UserInfoCard.vue'
import QuickReplyPanel from '@/components/Panel/QuickReplyPanel.vue'
import { resolveChannelScope } from '@/modules/conversations/channelScope'

const route = useRoute()
const props = defineProps({
  channelCode: { type: String, default: '' },
  accountId: { type: [String, Number], default: '' },
  embedded: { type: Boolean, default: false },
  readOnlyChannels: { type: Array, default: () => [] },
  readOnlyReason: { type: String, default: '需要在线桌面节点' }
})
const conversationStore = useConversationStore()
const settingsStore = useSettingsStore()
const userStore = useUserStore()
const activeTab = ref('info')
const channelScope = computed(() => resolveChannelScope({
  prop: props.channelCode,
  query: route.query.channel,
  meta: route.meta.fixedChannel || route.meta.channelCode
}))

// 头像更新回调 — 同步到 store 和列表
const onAvatarUpdated = ({ id, avatar }) => {
  conversationStore.updateConversationAvatar(id, avatar)
}

const onNationalityUpdated = (conversation) => {
  conversationStore.updateConversation(conversation)
}

// 切换会话时加入/离开房间，用于精准接收该会话的消息
watch(
  () => conversationStore.current?.id,
  (newId, oldId) => {
    if (oldId) {
      websocketService.leaveConversation(oldId)
    }
    if (newId) {
      websocketService.joinConversation(newId)
    }
  },
  { immediate: true }
)

// 组件挂载时设置坐席在线状态
onMounted(async () => {
  try {
    await updateSeatStatus('online')
    await conversationStore.fetchPoolStats()
    await conversationStore.fetchSeatLoad()
  } catch (err) {
    console.error('[Workbench] 初始化坐席状态失败:', err)
  }
})

</script>

<style scoped lang="scss">
.workbench-view {
  display: flex;
  height: 100%;
  background: #f5f7fa;
  overflow: hidden;

  &__left {
    flex-shrink: 0;
    width: $layout-left-width;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
    border-right: 1px solid $color-border;
    transition: width 0.3s ease;

    &--collapsed {
      width: 0;
      overflow: hidden;
      border-right: none;
    }
  }

  &__left-body {
    flex: 1;
    overflow-y: auto;
  }

  &__center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  &__empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__right {
    flex-shrink: 0;
    width: $layout-right-width;
    display: flex;
    flex-direction: column;
    background: #fff;
    border-left: 1px solid $color-border;
    transition: width 0.3s ease;

    &--collapsed {
      width: 0;
      overflow: hidden;
      border-left: none;
    }
  }

  &__right-body {
    flex: 1;
    overflow-y: auto;
  }

  &__panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: $header-height;
    padding: 0 12px;
    border-bottom: 1px solid $color-border;
    flex-shrink: 0;
    background: linear-gradient(90deg, #f8fafc 0%, #f1f5f9 100%);
  }

  &__panel-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
    font-weight: 600;
    color: $color-text-primary;
    letter-spacing: 0.5px;
  }

  &__side-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    cursor: pointer;
    background: #fff;
    color: $color-text-secondary;
    border-top: 1px solid $color-border;
    border-bottom: 1px solid $color-border;
    transition: background 0.2s;

    &:hover {
      background: $color-bg;
      color: $color-primary;
    }

    &--left {
      border-right: 1px solid $color-border;
    }

    &--right {
      border-left: 1px solid $color-border;
    }
  }

  &__tabs {
    height: 100%;
    display: flex;
    flex-direction: column;

    :deep(.el-tabs__header) {
      margin: 0;
      padding: 0 12px;
    }

    :deep(.el-tabs__content) {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
  }
}

@media (max-width: 1200px) {
  .workbench-view__left {
    width: 300px;

    &--collapsed { width: 0; }
  }

  .workbench-view__right {
    width: 260px;

    &--collapsed { width: 0; }
  }
}
</style>
