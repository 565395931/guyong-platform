<template>
  <div :class="['platform-accounts-view', { 'platform-accounts-view--embedded': props.embedded }]">
    <header v-if="!props.embedded" class="page-header">
      <div><span class="eyebrow">WECOM / CUSTOMER SERVICE</span><h1>微信客服账号</h1><p>管理企业主体、微信客服账号和安全启用策略。</p></div>
      <div class="safety-note"><el-icon><Lock /></el-icon><span>“客服1号”保持生产保护，当前阶段不可解除。</span></div>
    </header>

    <ConnectionTable
      :rows="connections"
      :selected-id="selectedId"
      :loading="connectionLoading"
      :verifying-id="verifyingId"
      :publishing-id="publishingId"
      :disabling-id="disablingId"
      :embedded="props.embedded"
      @add="openCreateConnection"
      @refresh="loadConnections"
      @select="selectConnection"
      @replace="openCredentialReplacement"
      @verify="verifyConnection"
      @publish="publishRuntime"
      @disable="disableRuntime"
    />
    <WecomAccountTable
      :rows="accounts"
      :connection="selectedConnection"
      :loading="accountLoading"
      @update-policy="savePolicy"
      @manage-allowlist="openAllowlist"
    />
    <OperationLogTable
      :rows="operationLogs"
      :connections="connections"
      :loading="operationLogLoading"
      :total="operationLogTotal"
      :page="operationLogPage"
      :page-size="operationLogPageSize"
      @query="loadOperationLogs"
    />
    <ConnectionDrawer v-model="drawerVisible" :connection="drawerConnection" :loading="saving" @save="saveConnection" />
    <AllowlistDrawer
      v-model="allowlistVisible"
      :account="allowlistAccount"
      :connection="selectedConnection"
      :rows="allowlistRows"
      :loading="allowlistLoading"
      :adding="allowlistAdding"
      @add="addAllowlist"
      @remove="removeAllowlist"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Lock } from '@element-plus/icons-vue'
import {
  createPlatformConnection,
  addAccountAllowlistEntry,
  disablePlatformConnectionRuntime,
  getConnectionAccounts,
  getAccountAllowlist,
  getPlatformConnections,
  getPlatformOperationLogs,
  publishPlatformConnectionRuntime,
  removeAccountAllowlistEntry,
  replacePlatformCredentials,
  updateAccountPolicy,
  verifyPlatformConnection
} from '@/api/platformConnections'
import ConnectionTable from './components/ConnectionTable.vue'
import ConnectionDrawer from './components/ConnectionDrawer.vue'
import WecomAccountTable from './components/WecomAccountTable.vue'
import AllowlistDrawer from './components/AllowlistDrawer.vue'
import OperationLogTable from './components/OperationLogTable.vue'

const props = defineProps({
  channelCode: { type: String, default: 'wecom_kf' },
  embedded: { type: Boolean, default: false }
})
const connections = ref([])
const accounts = ref([])
const selectedId = ref('')
const connectionLoading = ref(false)
const accountLoading = ref(false)
const saving = ref(false)
const verifyingId = ref('')
const publishingId = ref('')
const disablingId = ref('')
const drawerVisible = ref(false)
const drawerConnection = ref(null)
const allowlistVisible = ref(false)
const allowlistAccount = ref(null)
const allowlistRows = ref([])
const allowlistLoading = ref(false)
const allowlistAdding = ref(false)
const operationLogs = ref([])
const operationLogLoading = ref(false)
const operationLogTotal = ref(0)
const operationLogPage = ref(1)
const operationLogPageSize = ref(20)
const operationLogFilters = ref({ page: 1, pageSize: 20 })
const selectedConnection = computed(() => connections.value.find(row => row.id === selectedId.value) || null)

async function loadConnections(preferredId = '') {
  connectionLoading.value = true
  try {
    const response = await getPlatformConnections()
    connections.value = response.data || []
    selectedId.value = connections.value.some(row => row.id === preferredId)
      ? preferredId
      : connections.value.some(row => row.id === selectedId.value)
        ? selectedId.value
        : connections.value[0]?.id || ''
    await loadAccounts()
  } finally { connectionLoading.value = false }
}

async function loadAccounts() {
  if (!selectedId.value) { accounts.value = []; return }
  accountLoading.value = true
  try {
    const response = await getConnectionAccounts(selectedId.value)
    accounts.value = response.data || []
  } finally { accountLoading.value = false }
}

async function selectConnection(id) {
  selectedId.value = id
  allowlistVisible.value = false
  await loadAccounts()
}
function openCreateConnection() {
  drawerConnection.value = null
  drawerVisible.value = true
}
function openCredentialReplacement(connection) {
  drawerConnection.value = connection
  drawerVisible.value = true
}
async function saveConnection(payload) {
  saving.value = true
  try {
    if (drawerConnection.value) {
      const connectionId = drawerConnection.value.id
      await replacePlatformCredentials(connectionId, payload)
      drawerVisible.value = false
      drawerConnection.value = null
      ElMessage.success('企业微信凭据已替换，请重新验证并同步账号')
      await loadConnections(connectionId)
      await loadOperationLogs()
      return
    }
    const response = await createPlatformConnection(payload)
    drawerVisible.value = false
    ElMessage.success('企业连接已安全保存，请继续验证并同步账号')
    await loadConnections(response.data.id)
    await loadOperationLogs()
  } finally { saving.value = false }
}
async function verifyConnection(id) {
  verifyingId.value = id
  try {
    await verifyPlatformConnection(id)
    ElMessage.success('企业微信凭据验证通过，客服账号已同步')
    await loadConnections(id)
    await loadOperationLogs()
  } finally { verifyingId.value = '' }
}
async function publishRuntime(id) {
  publishingId.value = id
  try {
    await publishPlatformConnectionRuntime(id)
    ElMessage.success('企业微信运行配置已安全发布到网关')
    await loadConnections(id)
    await loadOperationLogs()
  } finally { publishingId.value = '' }
}
async function disableRuntime(id) {
  try {
    await ElMessageBox.confirm(
      '停用后网关将不再接收回调或发送消息，确认停用该企业连接？',
      '停用企业微信网关',
      { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' }
    )
  } catch { return }
  disablingId.value = id
  try {
    await disablePlatformConnectionRuntime(id)
    ElMessage.success('企业微信网关已停用，可以安全修改账号配置')
    await loadConnections(id)
    await loadOperationLogs()
  } finally { disablingId.value = '' }
}
async function savePolicy(accountId, policy) {
  await updateAccountPolicy(accountId, policy)
  ElMessage.success('账号安全策略已更新')
  await loadAccounts()
  await loadOperationLogs()
}
async function openAllowlist(account) {
  allowlistAccount.value = account
  allowlistVisible.value = true
  await loadAllowlist()
}
async function loadAllowlist() {
  if (!allowlistAccount.value) { allowlistRows.value = []; return }
  allowlistLoading.value = true
  try {
    const response = await getAccountAllowlist(allowlistAccount.value.id)
    allowlistRows.value = response.data || []
  } finally { allowlistLoading.value = false }
}
async function addAllowlist(payload) {
  allowlistAdding.value = true
  try {
    await addAccountAllowlistEntry(allowlistAccount.value.id, payload)
    ElMessage.success('测试联系人已加入白名单')
    await loadAllowlist()
    await loadOperationLogs()
  } finally { allowlistAdding.value = false }
}
async function removeAllowlist(entry) {
  try {
    await ElMessageBox.confirm(
      `确认将 ${entry.externalUserId} 移出测试白名单？`,
      '移出白名单',
      { type: 'warning', confirmButtonText: '确认移出', cancelButtonText: '取消' }
    )
  } catch { return }
  await removeAccountAllowlistEntry(allowlistAccount.value.id, entry.id)
  ElMessage.success('测试联系人已移出白名单')
  await loadAllowlist()
  await loadOperationLogs()
}
async function loadOperationLogs(filters = null) {
  if (filters) operationLogFilters.value = { ...filters }
  const query = operationLogFilters.value
  operationLogLoading.value = true
  try {
    const response = await getPlatformOperationLogs({
      page: query.page || operationLogPage.value,
      pageSize: query.pageSize || operationLogPageSize.value,
      connectionId: query.connectionId || undefined,
      accountId: query.accountId || undefined,
      action: query.action || undefined
    })
    const data = response.data || {}
    operationLogs.value = data.items || []
    operationLogTotal.value = Number(data.total || 0)
    operationLogPage.value = Number(data.page || 1)
    operationLogPageSize.value = Number(data.pageSize || 20)
  } finally { operationLogLoading.value = false }
}
async function refresh() {
  await Promise.all([loadConnections(), loadOperationLogs()])
}
defineExpose({ openCreate: openCreateConnection, refresh })
onMounted(async () => {
  await loadConnections()
  await loadOperationLogs()
})
</script>

<style scoped>
.platform-accounts-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; width: 100%; min-width: 0; min-height: 100%; padding: 20px; box-sizing: border-box; background: #f3f6f4; }
.platform-accounts-view--embedded { padding: 0; background: transparent; }
.platform-accounts-view > * { min-width: 0; max-width: 100%; box-sizing: border-box; }
.page-header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; padding: 2px 2px 6px; }
.page-header h1 { margin: 2px 0 4px; font-size: 23px; color: #12241c; }
.page-header p { margin: 0; color: #67766e; font-size: 13px; }
.eyebrow { color: #17845a; font-size: 10px; font-weight: 700; letter-spacing: 0; }
.safety-note { display: flex; align-items: center; gap: 8px; max-width: 390px; padding: 9px 12px; border-left: 3px solid #d87842; background: #fff7f0; color: #77503a; font-size: 13px; }
@media (max-width: 900px) { .page-header { align-items: flex-start; flex-direction: column; } }
</style>
