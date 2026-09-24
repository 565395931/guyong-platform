<template>
  <div class="channel-status" @click="showDetail = !showDetail">
    <el-tooltip :content="tooltipText" placement="bottom" :show-after="200">
      <div class="channel-status__indicator" :class="indicatorClass">
        <span class="channel-status__dot"></span>
        <span class="channel-status__label">{{ labelText }}</span>
      </div>
    </el-tooltip>

    <transition name="fade-down">
      <div v-if="showDetail" class="channel-status__panel">
        <div class="channel-status__panel-header">
          <span>渠道连接状态</span>
          <el-icon class="channel-status__close" @click.stop="showDetail = false"><Close /></el-icon>
        </div>
        <div class="channel-status__panel-body">
          <div v-if="loading && channels.length === 0" class="channel-status__loading">
            <el-icon class="is-loading"><Loading /></el-icon>
            正在检测...
          </div>
          <div v-for="ch in channels" :key="ch.channel" class="channel-status__channel">
            <div class="channel-status__channel-row">
              <span class="channel-status__channel-dot" :class="getChannelClass(ch)"></span>
              <div class="channel-status__channel-info">
                <span class="channel-status__channel-name">{{ ch.label }}</span>
                <span class="channel-status__channel-meta">
                  {{ getChannelStatusText(ch) }}
                </span>
                <div v-if="ch.sessions && ch.sessions.length" class="channel-status__sessions">
                  <div v-for="(s, i) in ch.sessions" :key="i" class="channel-status__session">
                    <span class="channel-status__session-dot" :class="getSessionClass(s.status)"></span>
                    <span class="channel-status__session-text">{{ s.name || s.phone || `Session ${i+1}` }}</span>
                    <span class="channel-status__session-status">{{ getSessionStatusText(s.status) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!loading && channels.length === 0" class="channel-status__empty">
            暂无已配置渠道
          </div>
        </div>
        <div class="channel-status__panel-footer">
          <span>每 {{ refreshInterval / 1000 }}s 自动刷新</span>
          <span class="channel-status__refresh" @click.stop="fetchStatus">手动刷新</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Close, Loading } from '@element-plus/icons-vue'
import { getChannelsStatus } from '@/api/channels'

const loading = ref(false)
const showDetail = ref(false)
const channels = ref([])
const overall = ref('UNKNOWN')
const refreshInterval = 60000
let timer = null

const labelText = computed(() => {
  switch (overall.value) {
    case 'HEALTHY': return '渠道正常'
    case 'WARNING': return '部分渠道异常'
    case 'CRITICAL': return '渠道离线'
    default: return '渠道状态'
  }
})

const indicatorClass = computed(() => {
  switch (overall.value) {
    case 'HEALTHY': return 'is-healthy'
    case 'WARNING': return 'is-warning'
    case 'CRITICAL': return 'is-critical'
    default: return 'is-unknown'
  }
})

const tooltipText = computed(() => {
  if (channels.value.length === 0) return '暂无已配置渠道'
  const total = channels.value.length
  const healthy = channels.value.filter(c => c.status === 'CONNECTED' || c.status === 'ACTIVE').length
  return `${healthy}/${total} 个渠道在线${overall.value !== 'HEALTHY' ? '（点击查看详情）' : ''}`
})

function getChannelClass(ch) {
  switch (ch.status) {
    case 'CONNECTED': return 'is-healthy'
    case 'ACTIVE': return 'is-active'
    case 'PARTIAL': return 'is-warning'
    case 'OFFLINE': return 'is-critical'
    default: return 'is-unknown'
  }
}

function getChannelStatusText(ch) {
  switch (ch.status) {
    case 'CONNECTED': return `已连接 · ${ch.accountCount} 个账号`
    case 'ACTIVE': return `已配置 ${ch.accountCount} 个账号`
    case 'PARTIAL': return `部分连接 · ${ch.accountCount} 个账号`
    case 'OFFLINE': return `离线 · ${ch.accountCount} 个账号`
    default: return `${ch.accountCount} 个账号`
  }
}

function getSessionClass(status) {
  switch (status) {
    case 'WORKING':
    case 'CONNECTED': return 'is-healthy'
    case 'SCAN_QR': return 'is-warning'
    case 'OFFLINE':
    case 'STOPPED': return 'is-critical'
    default: return 'is-unknown'
  }
}

function getSessionStatusText(status) {
  const map = {
    WORKING: '工作中',
    CONNECTED: '已连接',
    SCAN_QR: '等待扫码',
    OFFLINE: '离线',
    STOPPED: '已停止',
    STARTING: '启动中'
  }
  return map[status] || status
}

async function fetchStatus() {
  loading.value = true
  try {
    const res = await getChannelsStatus()
    if (res?.success && res?.data) {
      overall.value = res.data.overall || 'UNKNOWN'
      channels.value = res.data.channels || []
    }
  } catch (err) {
    console.warn('[ChannelStatus] 获取状态失败:', err.message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchStatus()
  timer = setInterval(fetchStatus, refreshInterval)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style lang="scss" scoped>
.channel-status {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;

  &__indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    transition: all 0.2s;

    &.is-healthy {
      background: rgba(34, 197, 94, 0.1);
      color: #16a34a;
    }
    &.is-warning {
      background: rgba(245, 158, 11, 0.1);
      color: #d97706;
    }
    &.is-critical {
      background: rgba(239, 68, 68, 0.1);
      color: #dc2626;
      animation: pulse-red 1.5s infinite;
    }
    &.is-unknown {
      background: rgba(107, 114, 128, 0.1);
      color: #6b7280;
    }
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
  }

  &__label {
    font-weight: 500;
    white-space: nowrap;
  }

  &__panel {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 8px;
    min-width: 300px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
    z-index: 1000;
    overflow: hidden;
  }

  &__panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: #f9fafb;
    border-bottom: 1px solid #f3f4f6;
    font-size: 13px;
    font-weight: 600;
    color: #1f2937;
  }

  &__close {
    cursor: pointer;
    color: #9ca3af;
    font-size: 16px;
    &:hover { color: #4b5563; }
  }

  &__panel-body {
    padding: 8px 0;
    max-height: 320px;
    overflow-y: auto;
  }

  &__loading {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 14px;
    color: #6b7280;
    font-size: 13px;
  }

  &__channel {
    padding: 8px 14px;
    &:hover { background: #f9fafb; }
  }

  &__channel-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  &__channel-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-top: 3px;
    flex-shrink: 0;

    &.is-healthy { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
    &.is-active { background: #3b82f6; box-shadow: 0 0 6px #3b82f6; }
    &.is-warning { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    &.is-critical { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
    &.is-unknown { background: #9ca3af; }
  }

  &__channel-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  &__channel-name {
    font-size: 13px;
    font-weight: 500;
    color: #1f2937;
  }

  &__channel-meta {
    font-size: 11px;
    color: #6b7280;
  }

  &__sessions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    padding-left: 8px;
    border-left: 2px solid #e5e7eb;
  }

  &__session {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  &__session-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;

    &.is-healthy { background: #22c55e; }
    &.is-warning { background: #f59e0b; }
    &.is-critical { background: #ef4444; }
    &.is-unknown { background: #9ca3af; }
  }

  &__session-text {
    flex: 1;
    color: #374151;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__session-status {
    color: #6b7280;
    flex-shrink: 0;
  }

  &__empty {
    padding: 20px 14px;
    text-align: center;
    color: #9ca3af;
    font-size: 13px;
  }

  &__panel-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    background: #f9fafb;
    border-top: 1px solid #f3f4f6;
    font-size: 11px;
    color: #6b7280;
  }

  &__refresh {
    cursor: pointer;
    color: #3b82f6;
    &:hover { text-decoration: underline; }
  }
}

.fade-down-enter-active,
.fade-down-leave-active {
  transition: all 0.2s ease;
}
.fade-down-enter-from,
.fade-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@keyframes pulse-red {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
</style>
