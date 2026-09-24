<template>
  <div class="waha-status" @click="showDetail = !showDetail">
    <el-tooltip :content="tooltipText" placement="bottom" :show-after="200">
      <div class="waha-status__indicator" :class="indicatorClass">
        <span class="waha-status__dot"></span>
        <span class="waha-status__label">{{ labelText }}</span>
      </div>
    </el-tooltip>

    <!-- 详细面板 -->
    <transition name="fade-down">
      <div v-if="showDetail" class="waha-status__panel">
        <div class="waha-status__panel-header">
          <span>WhatsApp 连接状态</span>
          <el-icon class="waha-status__close" @click.stop="showDetail = false"><Close /></el-icon>
        </div>
        <div class="waha-status__panel-body">
          <div v-if="loading && instances.length === 0" class="waha-status__loading">
            <el-icon class="is-loading"><Loading /></el-icon>
            正在检测...
          </div>
          <div v-for="inst in instances" :key="inst.containerName" class="waha-status__instance">
            <div class="waha-status__instance-row">
              <span class="waha-status__instance-dot" :class="getInstanceClass(inst)"></span>
              <div class="waha-status__instance-info">
                <span class="waha-status__instance-name">{{ inst.whatsappName || inst.phoneNumber || inst.containerName }}</span>
                <span class="waha-status__instance-meta">
                  {{ inst.containerName }} · {{ getStatusText(inst.status) }}
                </span>
                <span v-if="inst.error" class="waha-status__instance-error">{{ inst.error }}</span>
                <span
                  v-for="diag in inst.diagnostics || []"
                  :key="diag.type"
                  class="waha-status__instance-diagnostic"
                  :class="{ 'is-critical': diag.severity === 'critical' }"
                >
                  {{ diag.message }}
                  <small v-if="diag.hint">{{ diag.hint }}</small>
                </span>
              </div>
            </div>
          </div>
          <div v-if="!loading && instances.length === 0" class="waha-status__empty">
            暂无 WAHA 实例配置
          </div>
        </div>
        <div class="waha-status__panel-footer">
          <span>每 {{ refreshInterval / 1000 }}s 自动刷新</span>
          <span class="waha-status__refresh" @click.stop="fetchStatus">手动刷新</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Close, Loading } from '@element-plus/icons-vue'
import { getWahaHealthStatus } from '@/api/channels'

const loading = ref(false)
const showDetail = ref(false)
const instances = ref([])
const overall = ref('UNKNOWN')
const refreshInterval = 60000 // 60s
let timer = null

const issueCount = computed(() => instances.value.reduce((total, inst) => {
  return total + ((inst.diagnostics || []).length)
}, 0))

const labelText = computed(() => {
  switch (overall.value) {
    case 'HEALTHY': return 'WhatsApp 正常'
    case 'WARNING': return 'WhatsApp 部分异常'
    case 'CRITICAL': return 'WhatsApp 离线'
    default: return 'WhatsApp 状态'
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
  const connected = instances.value.filter(i => i.canReceiveMessages || i.status === 'CONNECTED').length
  const total = instances.value.length
  if (issueCount.value > 0) {
    return `${connected}/${total} 个实例在线，${issueCount.value} 个告警（点击查看详情）`
  }
  return `${connected}/${total} 个实例在线${overall.value !== 'HEALTHY' ? '（点击查看详情）' : ''}`
})

function getStatusClass(status) {
  switch (status) {
    case 'CONNECTED': return 'is-healthy'
    case 'SCAN_QR': return 'is-warning'
    case 'OFFLINE': return 'is-critical'
    default: return 'is-unknown'
  }
}

function getInstanceClass(inst) {
  const diagnostics = inst.diagnostics || []
  if (diagnostics.some(d => d.severity === 'critical')) return 'is-critical'
  if (diagnostics.length > 0) return 'is-warning'
  return getStatusClass(inst.status)
}

function getStatusText(status) {
  const map = {
    CONNECTED: '已连接',
    SCAN_QR: '等待扫码',
    OFFLINE: '离线',
    NO_SESSION: '无 Session',
    UNKNOWN: '未知'
  }
  return map[status] || status
}

async function fetchStatus() {
  loading.value = true
  try {
    const res = await getWahaHealthStatus()
    if (res?.success && res?.data) {
      overall.value = res.data.overall || 'UNKNOWN'
      instances.value = res.data.instances || []
    }
  } catch (err) {
    // 静默失败，不影响客服工作
    console.warn('[WahaStatus] 获取状态失败:', err.message)
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
.waha-status {
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
    min-width: 280px;
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
    max-height: 280px;
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

  &__instance {
    padding: 8px 14px;
    &:hover { background: #f9fafb; }
  }

  &__instance-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  &__instance-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-top: 3px;
    flex-shrink: 0;

    &.is-healthy { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
    &.is-warning { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    &.is-critical { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
    &.is-unknown { background: #9ca3af; }
  }

  &__instance-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__instance-name {
    font-size: 13px;
    font-weight: 500;
    color: #1f2937;
  }

  &__instance-meta {
    font-size: 11px;
    color: #6b7280;
  }

  &__instance-error {
    font-size: 11px;
    color: #dc2626;
  }

  &__instance-diagnostic {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: #d97706;

    &.is-critical {
      color: #dc2626;
    }

    small {
      color: #6b7280;
      line-height: 1.35;
    }
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
