<template>
  <div class="whatsapp-accounts">
    <!-- 顶部操作栏 -->
    <div class="whatsapp-accounts__header">
      <div class="whatsapp-accounts__title">
        <h2>账号管理</h2>
        <el-tag :type="getHealthTagType()" size="small">
          {{ wahaHealth ? 'WAHA 在线' : 'WAHA 离线' }}
        </el-tag>
        <el-tag type="info" size="small">
          WhatsApp {{ whatsappAccountCount }} / {{ maxInstances }} 已用
        </el-tag>
      </div>
      <div class="whatsapp-accounts__actions">
        <el-button @click="loadData" :loading="loading">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
        <el-button
          type="primary"
          @click="openAddDialog"
        >
          <el-icon><Plus /></el-icon>
          <span>添加账号</span>
        </el-button>
      </div>
    </div>

    <div v-if="syncJob" class="sync-progress">
      <div class="sync-progress__header">
        <div class="sync-progress__title">
          <span>历史同步</span>
          <el-tag :type="getSyncStatusType(syncJob.status)" size="small">
            {{ getSyncStatusLabel(syncJob.status) }}
          </el-tag>
        </div>
        <span class="sync-progress__message">{{ syncJob.message }}</span>
      </div>
      <el-progress
        :percentage="syncJob.percent || 0"
        :status="syncJob.status === 'failed' ? 'exception' : syncJob.status === 'completed' ? 'success' : undefined"
      />
      <div class="sync-progress__stats">
        <span>账号 {{ syncJob.progress?.accountsProcessed || 0 }} / {{ syncJob.progress?.totalAccounts || 0 }}</span>
        <span>联系人 {{ syncJob.progress?.chatsProcessed || 0 }} / {{ syncJob.progress?.totalChats || 0 }}</span>
        <span>获取 {{ syncJob.progress?.totalMessagesFetched || 0 }} 条</span>
        <span>提前跳过 {{ syncJob.progress?.totalEarlySkipped || 0 }} 条</span>
        <span>导入 {{ syncJob.progress?.totalImported || 0 }} 条</span>
        <span>更新 {{ syncJob.progress?.totalUpdated || 0 }} 条</span>
        <span>跳过 {{ syncJob.progress?.totalSkipped || 0 }} 条</span>
      </div>
      <div v-if="syncJob.progress?.currentChatId" class="sync-progress__current">
        当前联系人：{{ syncJob.progress.currentChatId }}
      </div>
      <el-alert
        v-if="syncJob.errors?.length"
        type="warning"
        :closable="false"
        class="sync-progress__errors"
      >
        <template #title>
          最近错误：{{ syncJob.errors[syncJob.errors.length - 1].error }}
        </template>
      </el-alert>
    </div>

    <!-- 账号列表 -->
    <el-table :data="accounts" v-loading="loading" style="width: 100%" empty-text="暂无已绑定账号">
      <el-table-column label="账号" min-width="150">
        <template #default="{ row }">
          {{ getAccountDisplayName(row) }}
        </template>
      </el-table-column>
      <el-table-column label="渠道" width="100" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="getChannelTagType(row.channel)">
            {{ getChannelLabel(row.channel) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="号码/标识" min-width="130">
        <template #default="{ row }">
          <span v-if="row.channel === 'whatsapp' && row.phone_number" :title="row.phone_number">
            {{ formatPhone(row.phone_number) }}
          </span>
          <span v-else>{{ row.external_id || '-' }}</span>
        </template>
      </el-table-column>

      <el-table-column prop="sessionName" label="Session" min-width="80" />
      <el-table-column label="端口" width="80" align="center">
        <template #default="{ row }">
          {{ row.port || '-' }}
        </template>
      </el-table-column>
      <el-table-column label="业务归类" width="130" align="center">
        <template #default="{ row }">
          <el-select
            v-model="row.knowledgeScope"
            size="small"
            class="scope-select"
            @change="value => updateAccountScope(row, value)"
          >
            <el-option
              v-for="option in knowledgeScopeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="连接状态" width="130" align="center">
        <template #default="{ row }">
          <el-tag :type="getStatusType(row.runtimeStatus || row.status)" effect="dark" size="small">
            {{ row.channel === 'whatsapp' ? getStatusLabel(row.runtimeStatus || row.status) : getAccountStatusLabel(row.accountStatus || row.status) }}
          </el-tag>
          <div v-if="row.receiveDiagnostics?.length" class="account-health">
            <el-tooltip :content="getDiagnosticsText(row)" placement="top">
              <el-tag :type="hasCriticalDiagnostic(row) ? 'danger' : 'warning'" size="small" effect="plain">
                接收告警
              </el-tag>
            </el-tooltip>
            <div class="account-health__message">
              {{ row.receiveDiagnostics[0].message }}
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatDate(row.created_at) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="420" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.channel === 'whatsapp'" size="small" @click="refreshStatus(row)">刷新状态</el-button>
          <el-button v-if="row.channel === 'whatsapp'" size="small" @click="restartInstance(row)">重启实例</el-button>
          <el-button
            v-if="row.channel === 'whatsapp'"
            size="small"
            type="warning"
            plain
            :loading="isSyncingAccount(row)"
            :disabled="historySyncRunning"
            @click="syncAccountHistory(row)"
          >
            同步历史
          </el-button>
          <el-button
            v-if="row.channel === 'whatsapp'"
            size="small"
            type="primary"
            @click="rescanQR(row)"
          >
            重新扫码
          </el-button>
          <el-button size="small" type="danger" @click="handleUnbind(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 添加账号对话框 -->
    <el-dialog
      v-model="addDialogVisible"
      title="添加账号"
      width="460px"
      :close-on-click-modal="false"
      @close="onDialogClose"
    >
      <!-- 步骤 1: 输入账号信息 -->
      <div v-if="step === 'input'" class="add-step">
        <el-form label-width="100px" style="width: 100%">
          <el-form-item label="渠道" required>
            <div class="channel-field">
              <el-select v-model="addForm.channel" style="width: 100%" @change="handleAddChannelChange">
                <el-option
                  v-for="option in channelOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <el-button circle @click="openChannelDialog('create')" title="新增渠道">
                <el-icon><Plus /></el-icon>
              </el-button>
              <el-button circle :disabled="!addForm.channel" @click="openChannelDialog('edit')" title="编辑当前渠道">
                <el-icon><Edit /></el-icon>
              </el-button>
            </div>
          </el-form-item>
          <el-form-item label="账号名称" required>
            <el-input v-model="addForm.accountName" placeholder="请输入账号名称（如：客服01）" />
          </el-form-item>
          <el-form-item label="业务归类">
            <el-select v-model="addForm.knowledgeScope" style="width: 100%">
              <el-option
                v-for="option in knowledgeScopeOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        >
          {{ addForm.channel === 'whatsapp' ? '系统将自动分配一个独立的 WAHA 实例并创建 Session。' : '当前会先创建渠道账号，用于后续会话、知识范围和坐席绑定。' }}
        </el-alert>
      </div>
      <template #footer>
        <div v-if="step === 'input'" style="text-align: right">
          <el-button @click="addDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="allocating" @click="createAccount">
            {{ addForm.channel === 'whatsapp' ? '分配实例并生成二维码' : '创建账号' }}
          </el-button>
        </div>
      </template>

      <!-- 步骤 2: 扫码 -->
      <div v-if="step === 'qr'" class="add-step">
        <div class="qr-section">
          <p class="qr-section__hint">请使用 WhatsApp 手机端扫描下方二维码</p>
          <!-- 错误提示 -->
          <el-alert
            v-if="qrError"
            :title="qrError.message"
            type="error"
            show-icon
            :closable="false"
            style="width: 100%; margin-bottom: 8px"
          >
            <template #default>
              <div style="font-weight: bold">{{ qrError.message }}</div>
              <div style="font-size: 12px; margin-top: 4px; color: #909399">
                {{ getErrorHint(qrError.type) }}
              </div>
            </template>
          </el-alert>
          <div class="qr-section__image">
            <el-image
              v-if="qrCodeUrl"
              :src="qrCodeUrl"
              fit="contain"
              style="width: 240px; height: 240px"
            />
            <div v-else class="qr-section__placeholder">
              <el-icon size="40"><Loading /></el-icon>
              <p>{{ qrError ? '等待重试...' : '正在生成二维码...' }}</p>
            </div>
          </div>
          <div class="qr-section__status">
            <el-tag :type="getStatusType(pollStatus)" effect="dark" size="default">
              {{ getStatusLabel(pollStatus) }}
            </el-tag>
            <span v-if="pollCountdown > 0" class="qr-section__countdown">
              倒计时: {{ Math.floor(pollCountdown / 60) }}分{{ pollCountdown % 60 }}秒
            </span>
          </div>
          <div class="qr-section__actions">
            <el-button @click="regenerateQR">重新生成二维码</el-button>
          </div>
        </div>
      </div>

      <!-- 步骤 3: 成功 -->
      <div v-if="step === 'success'" class="add-step add-step--success">
        <el-result icon="success" :title="addForm.channel === 'whatsapp' ? '扫码成功' : '创建成功'" :sub-title="addForm.channel === 'whatsapp' ? 'WhatsApp 账号已绑定' : '账号已创建'">
          <template #extra>
            <el-button type="primary" @click="addDialogVisible = false">完成</el-button>
          </template>
        </el-result>
      </div>

      <!-- 超时 -->
      <div v-if="step === 'timeout'" class="add-step">
        <el-result icon="warning" title="扫码超时" sub-title="二维码已过期，请重新生成">
          <template #extra>
            <el-button type="primary" @click="regenerateQR">重新生成二维码</el-button>
          </template>
        </el-result>
      </div>
    </el-dialog>

    <el-dialog
      v-model="channelDialogVisible"
      :title="channelDialogMode === 'create' ? '新增渠道' : '编辑渠道'"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form label-width="100px">
        <el-form-item label="渠道编码" required>
          <el-input
            v-model="channelForm.code"
            :disabled="channelDialogMode === 'edit'"
            placeholder="如 xiaohongshu"
          />
        </el-form-item>
        <el-form-item label="渠道名称" required>
          <el-input v-model="channelForm.label" placeholder="如 小红书" />
        </el-form-item>
        <el-form-item label="默认归类">
          <el-select v-model="channelForm.knowledgeScope" style="width: 100%">
            <el-option
              v-for="option in knowledgeScopeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="适配器">
          <el-select v-model="channelForm.adapterType" style="width: 100%">
            <el-option label="手动/待接入" value="manual" />
            <el-option label="WAHA" value="waha" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch
            v-model="channelForm.status"
            active-value="active"
            inactive-value="inactive"
            active-text="启用"
            inactive-text="停用"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="channelDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="channelSaving" @click="saveChannel">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, Loading, Edit } from '@element-plus/icons-vue'
import { wahaApi } from '@/api/waha'

// ========== 数据 ==========
const loading = ref(false)
const accounts = ref([])
const wahaHealth = ref(false)
const maxInstances = ref(2)
const healthStatus = ref(null)
const syncingHistory = ref(false)
const syncJob = ref(null)
const channels = ref([])
const channelOptions = computed(() => channels.value
  .filter(channel => channel.status !== 'inactive')
  .map(channel => ({ label: channel.label, value: channel.code })))
const knowledgeScopeOptions = [
  { label: '海外业务', value: 'overseas' },
  { label: '国内业务', value: 'domestic' },
  { label: '通用', value: 'common' },
  { label: '渠道专属', value: 'channel' }
]
const whatsappAccountCount = computed(() => accounts.value.filter(account => account.channel === 'whatsapp').length)
const historySyncRunning = computed(() => {
  const status = syncJob.value?.status
  return syncingHistory.value || status === 'pending' || status === 'running'
})

// 添加账号对话框
const addDialogVisible = ref(false)
const step = ref('input') // input | qr | success | timeout
const allocating = ref(false)
const addForm = ref({
  channel: 'whatsapp',
  accountName: '',
  sessionName: '',
  knowledgeScope: 'overseas'
})
const channelDialogVisible = ref(false)
const channelDialogMode = ref('create')
const channelSaving = ref(false)
const channelForm = ref({
  code: '',
  label: '',
  knowledgeScope: 'common',
  adapterType: 'manual',
  status: 'active'
})
const qrCodeUrl = ref('')
const pollStatus = ref('')
const pollCountdown = ref(0)
const qrError = ref(null) // QR 码获取过程中的错误 { type, message }
// 新创建的账号 ID（用于轮询状态）
let newAccountId = null

let pollTimer = null
let countdownTimer = null
let autoRefreshTimer = null
let syncJobTimer = null
let qrRetryTimer = null
let statusRefreshRunning = false
const AUTO_REFRESH_INTERVAL_MS = 90000
const SYNC_JOB_POLL_INTERVAL_MS = 5000

// ========== 生命周期 ==========
onMounted(() => {
  loadChannels()
  loadData()
  checkHealth()
  resumeSyncJob()
  document.addEventListener('visibilitychange', handleVisibilityChange)
  autoRefreshTimer = setInterval(refreshStatusSnapshot, AUTO_REFRESH_INTERVAL_MS)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  clearTimers()
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  stopSyncJobPolling()
})

// ========== 方法 ==========

async function refreshStatusSnapshot() {
  if (document.visibilityState === 'hidden' || statusRefreshRunning) return
  statusRefreshRunning = true
  try {
    await Promise.all([refreshAllStatus(), checkHealth()])
  } finally {
    statusRefreshRunning = false
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    refreshStatusSnapshot()
  }
}

async function loadChannels() {
  try {
    const res = await wahaApi.getChannels({ status: 'all' })
    channels.value = res.data?.data || []
    if (!channels.value.some(channel => channel.code === addForm.value.channel)) {
      const firstActive = channels.value.find(channel => channel.status !== 'inactive')
      if (firstActive) {
        addForm.value.channel = firstActive.code
        addForm.value.knowledgeScope = firstActive.knowledgeScope || defaultScopeForChannel(firstActive.code)
      }
    }
  } catch (err) {
    ElMessage.error('加载渠道失败: ' + (err.response?.data?.message || err.message))
  }
}

// 加载数据：获取 DB 账号 + WAHA session 状态
async function loadData() {
  loading.value = true
  try {
    const res = await wahaApi.getChannelAccounts()
    const dbAccounts = res.data?.data || []

    // 为每个账号获取状态
    // 只展示 active 账号（inactive 为已解绑，不显示也不计数）
    accounts.value = dbAccounts
      .filter(account => account.status === 'active')
      .map(account => ({
        ...account,
        accountStatus: account.status,
        runtimeStatus: account.channel === 'whatsapp' ? 'UNKNOWN' : account.status,
        status: account.channel === 'whatsapp' ? 'UNKNOWN' : account.status,
        knowledgeScope: account.knowledgeScope || account.knowledge_scope || defaultScopeForChannel(account.channel)
      }))
    applyHealthDiagnostics()

    // 异步刷新所有状态
    refreshAllStatus()
  } catch (err) {
    console.error('加载数据失败:', err)
    ElMessage.error('加载数据失败: ' + (err.response?.data?.message || err.message))
  } finally {
    loading.value = false
  }
}

// 检查 WAHA 健康状态
async function checkHealth() {
  try {
    const res = await wahaApi.healthStatus()
    const data = res.data?.data
    healthStatus.value = data || null
    wahaHealth.value = data?.overall === 'HEALTHY' || data?.overall === 'WARNING'
    if (data?.totalInstances) {
      maxInstances.value = data.totalInstances
    }
    applyHealthDiagnostics(data)
  } catch {
    healthStatus.value = null
    wahaHealth.value = false
  }
}

function applyHealthDiagnostics(data = healthStatus.value) {
  const instances = data?.instances || []
  const byAccountId = new Map(instances.filter(inst => inst.accountId).map(inst => [Number(inst.accountId), inst]))

  for (const account of accounts.value) {
    const inst = byAccountId.get(Number(account.id))
    account.receiveDiagnostics = inst?.diagnostics || []
    account.canReceiveMessages = inst?.canReceiveMessages ?? null
    account.lastInboundAt = inst?.lastInboundAt || null
  }
}

function getHealthTagType() {
  const overall = healthStatus.value?.overall
  if (overall === 'HEALTHY') return 'success'
  if (overall === 'WARNING') return 'warning'
  if (overall === 'CRITICAL') return 'danger'
  return wahaHealth.value ? 'success' : 'danger'
}

function applyStatusData(row, data = {}) {
  row.runtimeStatus = data.status || 'UNKNOWN'
  row.status = row.runtimeStatus
  if (data.phone) {
    row.phone_number = data.phone
  }
  if (data.whatsappName) {
    row.whatsapp_name = data.whatsappName
  }
}

// 刷新所有账号状态
async function refreshAllStatus() {
  for (const account of accounts.value) {
    if (account.channel === 'whatsapp' && account.sessionName) {
      try {
        const res = await wahaApi.getSessionStatus(account.sessionName, account.id)
        applyStatusData(account, res.data?.data || {})
      } catch {
        account.runtimeStatus = 'UNKNOWN'
        account.status = 'UNKNOWN'
      }
    }
  }
}

// 刷新单个账号状态
async function refreshStatus(row) {
  if (row.channel !== 'whatsapp' || !row.sessionName) return
  try {
    const res = await wahaApi.getSessionStatus(row.sessionName, row.id)
    applyStatusData(row, res.data?.data || {})
    ElMessage.success(`状态: ${getStatusLabel(row.status)}`)
  } catch (err) {
    ElMessage.error('获取状态失败: ' + (err.response?.data?.message || err.message))
  }
}

function handleAddChannelChange(channel) {
  const definition = getChannelDefinition(channel)
  addForm.value.knowledgeScope = definition?.knowledgeScope || defaultScopeForChannel(channel)
}

function openChannelDialog(mode) {
  channelDialogMode.value = mode
  if (mode === 'edit') {
    const channel = getChannelDefinition(addForm.value.channel)
    if (!channel) {
      ElMessage.warning('请先选择渠道')
      return
    }
    channelForm.value = {
      code: channel.code,
      label: channel.label,
      knowledgeScope: channel.knowledgeScope || defaultScopeForChannel(channel.code),
      adapterType: channel.adapterType || (channel.code === 'whatsapp' ? 'waha' : 'manual'),
      status: channel.status || 'active'
    }
  } else {
    channelForm.value = {
      code: '',
      label: '',
      knowledgeScope: 'common',
      adapterType: 'manual',
      status: 'active'
    }
  }
  channelDialogVisible.value = true
}

async function saveChannel() {
  const payload = {
    code: channelForm.value.code.trim().toLowerCase(),
    label: channelForm.value.label.trim(),
    knowledgeScope: channelForm.value.knowledgeScope,
    knowledgeChannels: ['all'],
    adapterType: channelForm.value.adapterType,
    status: channelForm.value.status
  }
  if (!payload.code || !payload.label) {
    ElMessage.warning('请填写渠道编码和名称')
    return
  }

  channelSaving.value = true
  try {
    if (channelDialogMode.value === 'create') {
      const res = await wahaApi.createChannel(payload)
      addForm.value.channel = res.data?.data?.code || payload.code
      addForm.value.knowledgeScope = res.data?.data?.knowledgeScope || payload.knowledgeScope
      ElMessage.success('渠道已新增')
    } else {
      const res = await wahaApi.updateChannel(payload.code, payload)
      if (addForm.value.channel === payload.code) {
        addForm.value.knowledgeScope = res.data?.data?.knowledgeScope || payload.knowledgeScope
      }
      ElMessage.success('渠道已更新')
    }
    channelDialogVisible.value = false
    await loadChannels()
  } catch (err) {
    ElMessage.error((channelDialogMode.value === 'create' ? '新增渠道失败: ' : '更新渠道失败: ') + (err.response?.data?.message || err.message))
  } finally {
    channelSaving.value = false
  }
}

async function updateAccountScope(row, value) {
  const previousValue = row.knowledge_scope || row.knowledgeScope || 'overseas'
  try {
    const res = await wahaApi.updateChannelAccount(row.id, {
      knowledgeScope: value,
      knowledgeChannels: ['all']
    })
    const data = res.data?.data || {}
    row.knowledgeScope = data.knowledgeScope || value
    row.knowledge_scope = row.knowledgeScope
    row.knowledgeChannels = data.knowledgeChannels || ['all']
    row.knowledge_channels = row.knowledgeChannels
    ElMessage.success('业务归类已更新')
  } catch (err) {
    row.knowledgeScope = previousValue
    ElMessage.error('业务归类更新失败: ' + (err.response?.data?.message || err.message))
  }
}

function isSyncingAccount(row) {
  const currentAccountId = syncJob.value?.progress?.currentAccountId
  return historySyncRunning.value && Number(currentAccountId) === Number(row.id)
}

// 同步指定 WhatsApp 账号历史消息
async function syncAccountHistory(row) {
  if (historySyncRunning.value || row.channel !== 'whatsapp') return

  try {
    const accountName = getAccountDisplayName(row)
    await ElMessageBox.confirm(
      `将从账号「${accountName}」同步最近联系人和历史消息，耗时可能较长。确定开始吗？`,
      '同步历史确认',
      { type: 'warning', confirmButtonText: '开始同步', cancelButtonText: '取消' }
    )

    syncingHistory.value = true
    const res = await wahaApi.syncAllHistory({ account_id: row.id, limit: 100 })
    const payload = res.data || {}
    if (payload.success !== false) {
      const job = payload.data
      if (job?.id) {
        syncJob.value = job
        localStorage.setItem('admin_sync_history_job_id', job.id)
        startSyncJobPolling(job.id)
      }
      ElMessage.success(payload.message || `账号「${accountName}」历史同步任务已开始`)
    } else {
      ElMessage.error(payload.message || '历史同步任务启动失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('历史同步任务启动失败: ' + (err.response?.data?.message || err.message || '未知错误'))
    }
  } finally {
    syncingHistory.value = false
  }
}

function resumeSyncJob() {
  const jobId = localStorage.getItem('admin_sync_history_job_id')
  if (jobId) {
    startSyncJobPolling(jobId)
  }
}

function startSyncJobPolling(jobId) {
  if (!jobId) return
  stopSyncJobPolling()
  pollSyncJob(jobId)
  syncJobTimer = setInterval(() => pollSyncJob(jobId), SYNC_JOB_POLL_INTERVAL_MS)
}

function stopSyncJobPolling() {
  if (syncJobTimer) {
    clearInterval(syncJobTimer)
    syncJobTimer = null
  }
}

async function pollSyncJob(jobId) {
  try {
    const res = await wahaApi.getSyncAllHistoryJob(jobId)
    const job = res.data?.data
    if (!job) return
    syncJob.value = job
    if (job.status === 'completed' || job.status === 'failed') {
      stopSyncJobPolling()
      localStorage.removeItem('admin_sync_history_job_id')
      if (job.status === 'completed') {
        refreshAllStatus()
      }
    }
  } catch (err) {
    stopSyncJobPolling()
    localStorage.removeItem('admin_sync_history_job_id')
    if (err.response?.status !== 404) {
      ElMessage.error('获取同步进度失败: ' + (err.response?.data?.message || err.message))
    }
  }
}

// 重启实例
async function restartInstance(row) {
  if (!row.sessionName) return
  try {
    await ElMessageBox.confirm(
      `确定要重启账号 "${row.account_name}" 的 WAHA 实例吗？`,
      '重启确认',
      { type: 'warning', confirmButtonText: '确认重启', cancelButtonText: '取消' }
    )
    await wahaApi.restartSession(row.sessionName, row.id)
    ElMessage.success('实例已重启')
    refreshStatus(row)
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('重启失败: ' + (err.response?.data?.message || err.message))
    }
  }
}

// 重新扫码
async function rescanQR(row) {
  if (!row.sessionName) return
  try {
    addForm.value = { channel: row.channel || 'whatsapp', accountName: row.account_name, sessionName: row.sessionName, knowledgeScope: row.knowledgeScope || defaultScopeForChannel(row.channel) }
    newAccountId = row.id
    addDialogVisible.value = true
    step.value = 'qr'
    qrCodeUrl.value = ''
    qrError.value = null
    pollStatus.value = 'STARTING'

    // 重启 session 以生成新的二维码
    await wahaApi.restartSession(row.sessionName, row.id)

    // 获取二维码并开始轮询
    await fetchQRCode(row.sessionName, row.id)
    startPolling(row.sessionName, row.id)
  } catch (err) {
    const errType = err.response?.data?.errorType || 'UNKNOWN'
    const errMsg = err.response?.data?.message || err.message
    qrError.value = { type: errType, message: errMsg }
  }
}

// ========== 添加账号流程 ==========

function openAddDialog() {
  step.value = 'input'
  addForm.value = { channel: 'whatsapp', accountName: '', sessionName: '', knowledgeScope: 'overseas' }
  qrCodeUrl.value = ''
  pollStatus.value = ''
  pollCountdown.value = 0
  qrError.value = null
  newAccountId = null
  addDialogVisible.value = true
}

async function createAccount() {
  if (addForm.value.channel === 'whatsapp') {
    await generateQR()
  } else {
    await createGenericAccount()
  }
}

async function createGenericAccount() {
  const accountName = addForm.value.accountName.trim()
  if (!accountName) {
    ElMessage.warning('请输入账号名称')
    return
  }

  allocating.value = true
  try {
    await wahaApi.createChannelAccount({
      channel: addForm.value.channel,
      account_name: accountName,
      adapter_type: getChannelDefinition(addForm.value.channel)?.adapterType || 'manual',
      knowledgeScope: addForm.value.knowledgeScope || defaultScopeForChannel(addForm.value.channel),
      knowledgeChannels: ['all'],
      config: {}
    })
    ElMessage.success('账号已创建')
    step.value = 'success'
    loadData()
  } catch (err) {
    ElMessage.error('创建账号失败: ' + (err.response?.data?.message || err.message))
  } finally {
    allocating.value = false
  }
}

// 分配实例并生成二维码
async function generateQR() {
  const accountName = addForm.value.accountName.trim()
  if (!accountName) {
    ElMessage.warning('请输入账号名称')
    return
  }
  if (whatsappAccountCount.value >= maxInstances.value) {
    ElMessage.warning(`已达到 WhatsApp 实例上限 ${maxInstances.value} 个`)
    return
  }

  allocating.value = true
  step.value = 'qr'
  qrCodeUrl.value = ''
  pollStatus.value = 'STARTING'

  try {
    // 1. 创建渠道账号（后端自动分配实例 + 创建 session + 设置 webhook）
    const createRes = await wahaApi.createChannelAccount({
      channel: 'whatsapp',
      account_name: accountName,
      adapter_type: 'waha',
      knowledgeScope: addForm.value.knowledgeScope || 'overseas',
      knowledgeChannels: ['all'],
      config: {}
    })

    const accountData = createRes.data?.data
    if (!accountData) {
      throw new Error('创建账号失败：未返回数据')
    }

    newAccountId = accountData.id
    addForm.value.sessionName = accountData.sessionName || 'default'

    // 如果后端返回了警告（session 启动失败），显示错误提示
    if (accountData.warning) {
      qrError.value = {
        type: accountData.warning.type,
        message: accountData.warning.message
      }
      ElMessage.warning('账号已创建，但实例启动遇到问题')
    } else {
      ElMessage.success('实例已分配，正在获取二维码...')
    }

    // 2. 获取二维码
    await fetchQRCode(addForm.value.sessionName, newAccountId)

    // 3. 开始轮询状态
    startPolling(addForm.value.sessionName, newAccountId)
  } catch (err) {
    console.error('分配实例失败:', err)
    ElMessage.error('分配实例失败: ' + (err.response?.data?.message || err.message))
    step.value = 'input'
  } finally {
    allocating.value = false
  }
}

// 获取二维码
async function fetchQRCode(sessionName, accountId = newAccountId) {
  try {
    const res = await wahaApi.getQRCode(sessionName, accountId)
    const data = res.data?.data
    if (data?.qr) {
      qrCodeUrl.value = data.qr
      qrError.value = null // 清除之前的错误
    } else if (data?.qr_code) {
      qrCodeUrl.value = data.qr_code
      qrError.value = null
    } else if (typeof data === 'string' && data.startsWith('data:image')) {
      qrCodeUrl.value = data
      qrError.value = null
    } else if (data?.errorType) {
      // 后端返回了具体错误类型
      qrError.value = { type: data.errorType, message: data.message || '未知错误' }
      // 对于某些可恢复的错误，5 秒后重试
      if (['TIMEOUT', 'SESSION_NOT_READY', 'WAHA_SERVER_ERROR'].includes(data.errorType)) {
        scheduleQrRetry(sessionName, accountId)
      }
    } else if (data?.message) {
      console.log('二维码提示:', data.message)
      // 二维码生成中，5 秒后重试（后端已有重试机制，不需要前端频繁请求）
      scheduleQrRetry(sessionName, accountId)
    }
  } catch (err) {
    console.error('获取二维码失败:', err)
    const errMsg = err.response?.data?.message || err.message
    const errType = err.response?.data?.errorType || 'NETWORK_ERROR'
    qrError.value = { type: errType, message: errMsg }
    // Session 可能还在启动中，5 秒后重试
    scheduleQrRetry(sessionName, accountId)
  }
}

function scheduleQrRetry(sessionName, accountId) {
  if (qrRetryTimer) clearTimeout(qrRetryTimer)
  qrRetryTimer = setTimeout(() => {
    qrRetryTimer = null
    if (addDialogVisible.value && step.value === 'qr') {
      fetchQRCode(sessionName, accountId)
    }
  }, 5000)
}

// 开始轮询状态
function startPolling(sessionName, accountId = newAccountId) {
  clearTimers()
  pollCountdown.value = 120 // 2 分钟超时
  const currentSessionName = sessionName

  // 倒计时
  countdownTimer = setInterval(() => {
    pollCountdown.value--
    if (pollCountdown.value <= 0) {
      clearTimers()
      step.value = 'timeout'
    }
  }, 1000)

  // 轮询状态（5 秒一次，避免对 WAHA 造成过大压力）
  pollTimer = setInterval(async () => {
    try {
      const res = await wahaApi.getSessionStatus(currentSessionName, accountId)
      const statusData = res.data?.data || {}
      const status = statusData.status || 'UNKNOWN'
      pollStatus.value = status

      // 如果后端返回了错误类型，显示错误提示
      if (statusData.errorType) {
        qrError.value = { type: statusData.errorType, message: statusData.message || '未知错误' }
      }

      if (status === 'CONNECTED' || status === 'WORKING') {
        clearTimers()
        step.value = 'success'
        loadData()
      }
    } catch (err) {
      console.error('轮询状态失败:', err)
    }
  }, 5000)
}

// 重新生成二维码
function regenerateQR() {
  clearTimers()
  const sessionName = addForm.value.sessionName
  if (!sessionName) {
    step.value = 'input'
    return
  }
  step.value = 'qr'
  qrCodeUrl.value = ''
  qrError.value = null
  pollStatus.value = 'STARTING'
  fetchQRCode(sessionName, newAccountId)
  startPolling(sessionName, newAccountId)
}

// ========== 删除账号 ==========

async function handleUnbind(row) {
  try {
    const deleteMessage = row.channel === 'whatsapp'
      ? `确定要删除账号 "${row.account_name}" 吗？此操作将同时删除 WAHA session 并释放实例。`
      : `确定要删除账号 "${row.account_name}" 吗？`
    await ElMessageBox.confirm(
      deleteMessage,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )

    // 删除渠道账号（后端会同时删除 WAHA session）
    if (row.id) {
      await wahaApi.deleteChannelAccount(row.id)
    } else if (row.sessionName) {
      await wahaApi.deleteSession(row.sessionName, row.id)
    }

    ElMessage.success('账号已删除')
    loadData()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败: ' + (err.response?.data?.message || err.message))
    }
  }
}

// ========== 工具函数 ==========

function clearTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  if (qrRetryTimer) { clearTimeout(qrRetryTimer); qrRetryTimer = null }
}

function onDialogClose() {
  clearTimers()
  step.value = 'input'
  qrCodeUrl.value = ''
  pollStatus.value = ''
  pollCountdown.value = 0
  qrError.value = null
  newAccountId = null
}

function getStatusType(status) {
  const map = {
    CONNECTED: 'success',
    WORKING: 'success',
    DISCONNECTED: 'info',
    SCAN_QR: 'primary',
    SCAN_QR_CODE: 'primary',
    STARTING: 'warning',
    FAILED: 'danger',
    NOT_FOUND: 'danger',
    UNKNOWN: 'info',
    active: 'success',
    inactive: 'info'
  }
  return map[status] || 'info'
}

function getStatusLabel(status) {
  const map = {
    CONNECTED: '已连接',
    WORKING: '已连接',
    DISCONNECTED: '已断开',
    SCAN_QR: '等待扫码',
    SCAN_QR_CODE: '等待扫码',
    STARTING: '启动中',
    FAILED: '连接失败',
    NOT_FOUND: '未找到',
    UNKNOWN: '未知'
  }
  return map[status] || status || '未知'
}

function getSyncStatusType(status) {
  const map = {
    pending: 'info',
    running: 'warning',
    completed: 'success',
    failed: 'danger'
  }
  return map[status] || 'info'
}

function getSyncStatusLabel(status) {
  const map = {
    pending: '等待中',
    running: '同步中',
    completed: '已完成',
    failed: '失败'
  }
  return map[status] || status || '未知'
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 格式化手机号显示（8613800138000 → +86 138 0013 8000）
function formatPhone(phone) {
  if (!phone) return '-'
  // 如果以 86 开头且长度 > 11，按中国号码格式化
  if (phone.startsWith('86') && phone.length > 11) {
    return `+86 ${phone.slice(2)}`
  }
  // 其他情况加 + 前缀
  return phone.startsWith('+') ? phone : `+${phone}`
}

function getAccountDisplayName(row) {
  if (row.channel === 'whatsapp') return getWhatsAppAccountName(row)
  return row.account_name || '-'
}

function getWhatsAppAccountName(row) {
  return row.whatsapp_name || (row.phone_number ? formatPhone(row.phone_number) : row.account_name || '-')
}

function getChannelLabel(channel) {
  return getChannelDefinition(channel)?.label || channel || '-'
}

function getChannelTagType(channel) {
  const map = {
    whatsapp: 'success',
    wechat: 'primary',
    douyin: 'warning'
  }
  return map[channel] || 'info'
}

function getChannelDefinition(channel) {
  return channels.value.find(item => item.code === channel) || null
}

function getAccountStatusLabel(status) {
  const map = {
    active: '启用',
    inactive: '停用'
  }
  return map[status] || status || '未知'
}

function defaultScopeForChannel(channel) {
  const definition = getChannelDefinition(channel)
  if (definition?.knowledgeScope) return definition.knowledgeScope
  if (channel === 'whatsapp') return 'overseas'
  if (['wechat', 'douyin'].includes(channel)) return 'domestic'
  return 'common'
}

function hasCriticalDiagnostic(row) {
  return (row.receiveDiagnostics || []).some(diag => diag.severity === 'critical')
}

function getDiagnosticsText(row) {
  return (row.receiveDiagnostics || [])
    .map(diag => `${diag.message}${diag.hint ? `：${diag.hint}` : ''}`)
    .join('\n')
}

// 获取错误提示的可读描述
function getErrorHint(errorType) {
  const hints = {
    WAHA_OFFLINE: '请检查 Docker 容器是否正在运行：docker compose ps',
    SESSION_CONFLICT: '系统已自动清理旧 session，请重试',
    AUTH_ERROR: '请检查 .env 中的 API Key 与 docker-compose.yml 是否一致',
    TIMEOUT: 'WAHA 容器可能正在启动，请稍后重试',
    PROXY_ERROR: '请检查代理配置（WHATSAPP_PROXY_SERVER）是否正确',
    WAHA_SERVER_ERROR: 'WAHA 内部错误，请查看容器日志：docker logs waha-1',
    ENDPOINT_NOT_FOUND: 'WAHA 版本不兼容，请检查镜像版本',
    SESSION_NOT_READY: 'Session 尚未就绪，请稍后',
    NETWORK_ERROR: '网络连接失败，请检查后端服务和 WAHA 容器状态',
    UNKNOWN: '未知错误，请查看后端日志'
  }
  return hints[errorType] || hints.UNKNOWN
}
</script>

<style lang="scss" scoped>
.whatsapp-accounts {
  padding: 20px;

  &__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  &__title {
    display: flex;
    align-items: center;
    gap: 12px;

    h2 {
      margin: 0;
      font-size: 20px;
    }
  }

  &__actions {
    display: flex;
    gap: 8px;
  }
}

.sync-progress {
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fff;

  &__header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
  }

  &__title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: #303133;
    white-space: nowrap;
  }

  &__message {
    flex: 1;
    min-width: 0;
    color: #606266;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-top: 10px;
    font-size: 12px;
    color: #606266;
  }

  &__current {
    margin-top: 8px;
    font-size: 12px;
    color: #909399;
  }

  &__errors {
    margin-top: 10px;
  }
}

.add-step {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  &--success {
    min-height: 280px;
  }
}

.form-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.account-health {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: 6px;

  &__message {
    max-width: 150px;
    font-size: 11px;
    line-height: 1.35;
    color: #d97706;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.scope-select {
  width: 110px;
}

.channel-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px 32px;
  gap: 8px;
  width: 100%;
}

.qr-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;

  &__hint {
    color: #606266;
    margin: 0;
  }

  &__image {
    width: 240px;
    height: 240px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed #dcdfe6;
    border-radius: 8px;
  }

  &__placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: #909399;
  }

  &__status {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__countdown {
    font-size: 13px;
    color: #909399;
  }

  &__actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
}
</style>

