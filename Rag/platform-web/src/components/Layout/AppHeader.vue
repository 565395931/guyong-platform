<template>
  <header class="app-header">
    <div class="app-header__left">
      <el-button class="app-header__menu-btn" text :icon="Menu" title="打开导航" @click="$emit('toggle-mobile-menu')" />
      <div class="app-header__title">{{ pageTitle }}</div>
    </div>
    <div class="app-header__right">
      <el-popover
        placement="bottom-end"
        trigger="click"
        :width="260"
        popper-class="reminder-popover"
      >
        <div class="reminder-menu">
          <div class="reminder-menu__row">
            <span>声音提醒</span>
            <div class="reminder-menu__sound-tools">
              <el-button size="small" text :icon="VideoPlay" @click="handleTestSound">试听</el-button>
              <el-switch v-model="reminderSettings.soundEnabled" size="small" @change="handleSoundChange" />
            </div>
          </div>
          <div class="reminder-menu__row">
            <span>提示音</span>
            <el-select
              v-model="reminderSettings.soundTone"
              size="small"
              class="reminder-menu__tone-select"
              @change="handleToneChange"
            >
              <el-option
                v-for="tone in soundToneOptions"
                :key="tone.value"
                :label="tone.label"
                :value="tone.value"
              />
            </el-select>
          </div>
          <div class="reminder-menu__row">
            <span>桌面通知</span>
            <el-switch
              v-model="reminderSettings.desktopEnabled"
              size="small"
              :disabled="desktopNotificationUnavailable"
              @change="handleDesktopChange"
            />
          </div>
          <div v-if="desktopPermission === 'denied'" class="reminder-menu__hint">浏览器已拒绝通知权限</div>
          <div v-else-if="desktopPermission === 'unsupported'" class="reminder-menu__hint">当前浏览器不支持桌面通知</div>
          <div v-else-if="desktopPermission === 'insecure'" class="reminder-menu__hint">桌面通知需要 HTTPS 或 localhost 访问</div>
        </div>
        <template #reference>
          <el-button
            class="app-header__reminder-btn"
            size="small"
            circle
            :type="reminderActive ? 'primary' : 'default'"
            :icon="Bell"
            title="新消息提醒设置"
          />
        </template>
      </el-popover>
      <el-button
        v-if="isDesktop"
        class="app-header__desktop-settings"
        size="small"
        :icon="Setting"
        title="桌面端连接设置"
        @click="$emit('open-desktop-settings')"
      >
        连接设置
      </el-button>
      <ChannelStatusIndicator v-if="channelChrome.showWahaStatus" />
      <el-dropdown @command="handleCommand">
        <div class="app-header__user-info">
          <el-avatar :size="32" :src="avatar">
            {{ username.charAt(0) }}
          </el-avatar>
          <span class="app-header__username">{{ username }}</span>
          <el-icon class="app-header__arrow"><ArrowDown /></el-icon>
        </div>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="settings">个人设置</el-dropdown-item>
            <el-dropdown-item
              v-if="isAdmin"
              command="restart-backend"
              :icon="RefreshRight"
              :disabled="restartingBackend"
            >
              {{ restartingBackend ? '后端重启中…' : '重启后端' }}
            </el-dropdown-item>
            <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, Bell, Menu, RefreshRight, Setting, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { messageReminder, SOUND_TONE_OPTIONS } from '@/utils/messageReminder'
import { resolveChannelChrome } from '@/modules/navigation/channelChrome'
import ChannelStatusIndicator from './ChannelStatusIndicator.vue'
import { getDesktopBridge } from '@/utils/runtimeConfig'
import { restartBackend, waitForBackendRestart } from '@/api/systemControl'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
defineEmits(['toggle-mobile-menu', 'open-desktop-settings'])

const pageTitle = computed(() => route.meta?.title || '工作台')
const channelChrome = computed(() => resolveChannelChrome(route.meta?.channelCode))
const username = computed(() => userStore.userInfo?.username || '客服')
const avatar = computed(() => userStore.userInfo?.avatar || '')
const isAdmin = computed(() => userStore.userInfo?.role === 'admin')
const isDesktop = Boolean(getDesktopBridge())
const restartingBackend = ref(false)
const reminderSettings = ref(messageReminder.getSettings())
const desktopPermission = ref(messageReminder.getDesktopPermission())
const soundToneOptions = SOUND_TONE_OPTIONS
const desktopNotificationUnavailable = computed(() =>
  ['denied', 'unsupported', 'insecure'].includes(desktopPermission.value)
)
const reminderActive = computed(() =>
  reminderSettings.value.soundEnabled ||
  (reminderSettings.value.desktopEnabled && desktopPermission.value === 'granted')
)

const handleSoundChange = (enabled) => {
  messageReminder.updateSettings({ soundEnabled: enabled })
  if (enabled) {
    messageReminder.unlockAudio()
  }
}

const handleTestSound = async () => {
  reminderSettings.value.soundEnabled = true
  const played = await messageReminder.testSound(reminderSettings.value.soundTone)
  if (played) {
    ElMessage.success('已播放试听音')
  } else {
    ElMessage.warning('浏览器未放行音频，请检查标签页声音权限或系统音量')
  }
}

const handleToneChange = (tone) => {
  messageReminder.updateSettings({ soundTone: tone })
}

const handleDesktopChange = async (enabled) => {
  if (!enabled) {
    messageReminder.updateSettings({ desktopEnabled: false })
    return
  }
  const permission = await messageReminder.requestDesktopPermission()
  desktopPermission.value = permission
  if (permission !== 'granted') {
    reminderSettings.value.desktopEnabled = false
    messageReminder.updateSettings({ desktopEnabled: false })
    if (permission === 'insecure') {
      ElMessage.warning('桌面通知需要 HTTPS 或 localhost 访问')
    } else if (permission === 'denied') {
      ElMessage.warning('浏览器已拒绝通知权限，请在站点设置中开启')
    } else if (permission === 'unsupported') {
      ElMessage.warning('当前浏览器不支持桌面通知')
    }
  }
}

const handleRestartBackend = async () => {
  if (restartingBackend.value) return
  try {
    await ElMessageBox.confirm(
      '重启期间工作台会短暂断开，通常需要几秒钟。确定现在重启吗？',
      '重启后端服务',
      {
        confirmButtonText: '重启后端',
        cancelButtonText: '取消',
        type: 'warning',
        autofocus: false
      }
    )
  } catch {
    return
  }

  restartingBackend.value = true
  const progressMessage = ElMessage({
    message: '后端正在重启，请稍候…',
    type: 'info',
    duration: 0,
    showClose: true
  })
  try {
    const { previousPid } = await restartBackend()
    await waitForBackendRestart(previousPid)
    progressMessage.close()
    ElMessage.success('后端已重启并恢复连接')
  } catch (error) {
    progressMessage.close()
    ElMessage({
      message: error?.message || '后端重启失败，请稍后重试',
      type: 'error',
      duration: 0,
      showClose: true
    })
  } finally {
    restartingBackend.value = false
  }
}

const handleCommand = async (command) => {
  if (command === 'logout') {
    userStore.logout()
  } else if (command === 'settings') {
    router.push('/settings/profile')
  } else if (command === 'restart-backend') {
    await handleRestartBackend()
  }
}
</script>

<style lang="scss" scoped>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 56px;
  padding: 0 20px;
  background-color: #ffffff;
  border-bottom: 1px solid #e6e6e6;

  &__left { display: flex; align-items: center; min-width: 0; gap: 12px; }

  &__menu-btn { display: none; margin-right: 4px; }

  &__title {
    font-size: 18px;
    font-weight: 500;
    color: #1f2937;
    flex-shrink: 0;
  }

  &__right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__reminder-btn {
    flex-shrink: 0;
  }

  &__user-info {
    display: flex;
    align-items: center;
    cursor: pointer;
    outline: none;
  }

  &__username {
    margin: 0 6px 0 8px;
    font-size: 14px;
    color: #374151;
  }

  &__arrow {
    font-size: 12px;
    color: #6b7280;
  }
}

@media (max-width: 900px) {
  .app-header {
    height: 52px;
    padding: 0 10px 0 6px;

    &__menu-btn { display: inline-flex; flex-shrink: 0; }
    &__title { overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    &__right { gap: 6px; }
    &__username { display: none; }
    &__arrow { margin-left: 4px; }
  }
}

:global(.reminder-menu) {
  padding: 8px 0;
}

:global(.reminder-menu__row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-width: 160px;
  padding: 7px 12px;
  font-size: 13px;
  color: #374151;
}

:global(.reminder-menu__hint) {
  max-width: 180px;
  padding: 4px 12px 8px;
  font-size: 12px;
  color: #ef4444;
  line-height: 1.4;
}

:global(.reminder-menu__sound-tools) {
  display: flex;
  align-items: center;
  gap: 6px;
}

:global(.reminder-menu__tone-select) {
  width: 132px;
}
</style>
