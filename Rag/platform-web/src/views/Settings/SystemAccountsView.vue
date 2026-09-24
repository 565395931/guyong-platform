<template>
  <div class="system-accounts-view">
    <header class="page-heading">
      <div>
        <span class="page-kicker">ACCESS CONTROL</span>
        <h1>系统账号管理</h1>
        <p>管理后台登录账号、岗位权限和启用状态</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增账号</el-button>
    </header>

    <section class="account-toolbar" aria-label="账号筛选">
      <el-input
        v-model="filters.keyword"
        class="keyword-input"
        clearable
        :prefix-icon="Search"
        placeholder="搜索用户名或邮箱"
        @keyup.enter="loadAccounts"
        @clear="loadAccounts"
      />
      <el-select v-model="filters.role" clearable placeholder="全部角色" @change="loadAccounts">
        <el-option v-for="item in roleOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="全部状态" @change="loadAccounts">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button :icon="Search" @click="loadAccounts">查询</el-button>
      <el-tooltip content="重新载入" placement="top">
        <el-button circle :icon="Refresh" :loading="loading" aria-label="重新载入" @click="loadAccounts" />
      </el-tooltip>
    </section>

    <main class="account-table-wrap">
      <el-table v-loading="loading" :data="accounts" height="100%" empty-text="暂无系统账号">
        <el-table-column prop="username" label="用户名" min-width="150">
          <template #default="{ row }">
            <div class="account-name">
              <span>{{ row.username }}</span>
              <el-tag v-if="isSelf(row)" size="small" effect="plain">当前账号</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="210">
          <template #default="{ row }">{{ row.email || '-' }}</template>
        </el-table-column>
        <el-table-column prop="role" label="角色" width="120">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" effect="light">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button link type="primary" :icon="Key" @click="openPasswordReset(row)">重置密码</el-button>
              <el-tooltip :disabled="!isSelf(row)" content="不能停用当前登录账号" placement="top">
                <span>
                  <el-button
                    link
                    :type="row.status === 'active' ? 'warning' : 'success'"
                    :disabled="isSelf(row)"
                    @click="toggleStatus(row)"
                  >
                    {{ row.status === 'active' ? '停用' : '启用' }}
                  </el-button>
                </span>
              </el-tooltip>
              <el-tooltip :disabled="!isSelf(row)" content="不能删除当前登录账号" placement="top">
                <span>
                  <el-button link type="danger" :disabled="isSelf(row)" :icon="Delete" @click="removeAccount(row)">删除</el-button>
                </span>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </main>

    <el-dialog v-model="accountDialogVisible" :title="editingId ? '编辑系统账号' : '新增系统账号'" width="520px" destroy-on-close>
      <el-alert
        v-if="editingId"
        class="account-dialog__notice"
        type="info"
        show-icon
        :closable="false"
      >
        <template #title>账号概览</template>
        <template #default>
          先确认编号、创建时间和更新时间，再修改角色或状态。
        </template>
      </el-alert>
      <el-alert
        v-else
        class="account-dialog__notice"
        type="warning"
        show-icon
        :closable="false"
      >
        <template #title>新建账号提示</template>
        <template #default>
          请先确认角色和状态，密码至少 6 位，邮箱可选但建议填写。
        </template>
      </el-alert>

      <el-descriptions
        v-if="editingId"
        class="account-dialog__overview"
        :column="2"
        border
        size="small"
      >
        <el-descriptions-item
          v-for="item in accountOverview"
          :key="item.label"
          :label="item.label"
        >
          {{ item.value }}
        </el-descriptions-item>
      </el-descriptions>

      <el-form label-position="top" @submit.prevent="submitAccount">
        <el-form-item label="用户名" :error="formErrors.username" required>
          <el-input v-model="accountForm.username" :disabled="Boolean(editingId)" maxlength="50" autocomplete="off" />
        </el-form-item>
        <el-form-item label="邮箱" :error="formErrors.email">
          <el-input v-model="accountForm.email" maxlength="100" autocomplete="off" placeholder="可选" />
        </el-form-item>
        <el-form-item v-if="!editingId" label="初始密码" :error="formErrors.password" required>
          <el-input v-model="accountForm.password" type="password" show-password maxlength="72" autocomplete="new-password" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="角色" :error="formErrors.role" required>
            <el-select v-model="accountForm.role" :disabled="isEditingSelf" class="full-width">
              <el-option v-for="item in roleOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态" :error="formErrors.status" required>
            <el-select v-model="accountForm.status" :disabled="isEditingSelf" class="full-width">
              <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="accountDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitAccount">{{ editingId ? '保存修改' : '创建账号' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="passwordDialogVisible" title="重置密码" width="420px" destroy-on-close>
      <p class="dialog-note">为账号 <strong>{{ passwordTarget?.username }}</strong> 设置新密码。</p>
      <el-form label-position="top" @submit.prevent="submitPasswordReset">
        <el-form-item label="新密码" :error="passwordError" required>
          <el-input v-model="newPassword" type="password" show-password maxlength="72" autocomplete="new-password" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitPasswordReset">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Key, Plus, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/stores/user'
import {
  createSystemAccount,
  deleteSystemAccount,
  listSystemAccounts,
  resetSystemAccountPassword,
  updateSystemAccount
} from '@/api/systemAccounts'
import { normalizeAccountForm, validateAccountForm } from '@/modules/systemAccounts/accountRules'
import { buildAccountOverview } from '@/modules/systemAccounts/accountOverview'

const roleOptions = [
  { value: 'admin', label: '管理员' },
  { value: 'supervisor', label: '主管' },
  { value: 'agent', label: '坐席' }
]
const statusOptions = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' }
]
const blankForm = () => ({ username: '', email: '', password: '', role: 'agent', status: 'active' })

const userStore = useUserStore()
const accounts = ref([])
const loading = ref(false)
const saving = ref(false)
const filters = reactive({ keyword: '', role: '', status: '' })
const accountDialogVisible = ref(false)
const passwordDialogVisible = ref(false)
const editingId = ref(null)
const accountForm = reactive(blankForm())
const formErrors = reactive({})
const passwordTarget = ref(null)
const newPassword = ref('')
const passwordError = ref('')

const currentUserId = computed(() => userStore.userInfo?.id)
const isEditingSelf = computed(() => Number(editingId.value) === Number(currentUserId.value))
const editingAccount = computed(() => accounts.value.find(item => Number(item.id) === Number(editingId.value)) || null)
const accountOverview = computed(() => buildAccountOverview(editingAccount.value || {}, {
  roleLabel,
  statusLabel,
  formatDate,
  isSelf
}))

function clearObject(object) {
  Object.keys(object).forEach(key => delete object[key])
}

function isSelf(account) {
  return Number(account.id) === Number(currentUserId.value)
}

function roleLabel(role) {
  return roleOptions.find(item => item.value === role)?.label || role || '-'
}

function roleTagType(role) {
  return role === 'admin' ? 'danger' : role === 'supervisor' ? 'warning' : 'primary'
}

function statusLabel(status) {
  return statusOptions.find(item => item.value === status)?.label || status || '-'
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false })
}

async function loadAccounts() {
  loading.value = true
  try {
    const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
    const response = await listSystemAccounts(params)
    accounts.value = Array.isArray(response.data) ? response.data : []
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(accountForm, blankForm())
  clearObject(formErrors)
  accountDialogVisible.value = true
}

function openEdit(account) {
  editingId.value = account.id
  Object.assign(accountForm, blankForm(), account)
  accountForm.password = ''
  clearObject(formErrors)
  accountDialogVisible.value = true
}

async function submitAccount() {
  const normalized = normalizeAccountForm(accountForm)
  const validation = validateAccountForm(normalized, { creating: !editingId.value })
  clearObject(formErrors)
  Object.assign(formErrors, validation)
  if (Object.keys(validation).length) return
  saving.value = true
  try {
    if (editingId.value) {
      await updateSystemAccount(editingId.value, {
        email: normalized.email,
        role: normalized.role,
        status: normalized.status
      })
      ElMessage.success('账号已更新')
    } else {
      await createSystemAccount(normalized)
      ElMessage.success('账号已创建')
    }
    accountDialogVisible.value = false
    await loadAccounts()
  } finally {
    saving.value = false
  }
}

function openPasswordReset(account) {
  passwordTarget.value = account
  newPassword.value = ''
  passwordError.value = ''
  passwordDialogVisible.value = true
}

async function submitPasswordReset() {
  if (newPassword.value.length < 6) {
    passwordError.value = '密码至少 6 个字符'
    return
  }
  if (newPassword.value.length > 72) {
    passwordError.value = '密码不能超过 72 个字符'
    return
  }
  saving.value = true
  try {
    await resetSystemAccountPassword(passwordTarget.value.id, newPassword.value)
    passwordDialogVisible.value = false
    ElMessage.success('密码已重置')
  } finally {
    saving.value = false
  }
}

async function toggleStatus(account) {
  const nextStatus = account.status === 'active' ? 'disabled' : 'active'
  const action = nextStatus === 'active' ? '启用' : '停用'
  await ElMessageBox.confirm(`确定${action}账号“${account.username}”吗？`, `${action}账号`, {
    confirmButtonText: action,
    cancelButtonText: '取消',
    type: nextStatus === 'active' ? 'success' : 'warning'
  })
  await updateSystemAccount(account.id, { status: nextStatus })
  ElMessage.success(`账号已${action}`)
  await loadAccounts()
}

async function removeAccount(account) {
  await ElMessageBox.confirm(`删除后无法恢复，确定删除账号“${account.username}”吗？`, '删除账号', {
    confirmButtonText: '删除',
    cancelButtonText: '取消',
    type: 'warning'
  })
  await deleteSystemAccount(account.id)
  ElMessage.success('账号已删除')
  await loadAccounts()
}

onMounted(loadAccounts)
</script>

<style scoped lang="scss">
.system-accounts-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #f4f6f7;
  color: #253540;
}

.page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 22px clamp(18px, 3vw, 36px) 18px;
  border-bottom: 1px solid #d8e0e5;
  background: #fff;
}

.page-heading h1 {
  margin: 3px 0 2px;
  font-size: 24px;
  letter-spacing: 0;
}

.page-heading p {
  margin: 0;
  color: #7b8790;
  font-size: 13px;
}

.page-kicker {
  color: #4f6f82;
  font-family: Consolas, monospace;
  font-size: 10px;
  letter-spacing: 1.4px;
}

.account-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px clamp(18px, 3vw, 36px);
  border-bottom: 1px solid #dde4e8;
  background: #f8fafb;
}

.account-toolbar .keyword-input {
  width: min(320px, 34vw);
}

.account-toolbar :deep(.el-select) {
  width: 140px;
}

.account-table-wrap {
  flex: 1;
  min-height: 280px;
  padding: 16px clamp(18px, 3vw, 36px) 24px;
  overflow: hidden;
}

.account-table-wrap :deep(.el-table) {
  border: 1px solid #dfe5e8;
}

.account-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.row-actions {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

.row-actions > span {
  display: inline-flex;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.full-width {
  width: 100%;
}

.dialog-note {
  margin: -4px 0 18px;
  color: #64727c;
  font-size: 13px;
}

.account-dialog__notice {
  margin-bottom: 14px;
  border-radius: 8px;
}

.account-dialog__overview {
  margin-bottom: 16px;
}

@media (max-width: 760px) {
  .page-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .account-toolbar {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .account-toolbar .keyword-input {
    width: 100%;
  }

  .account-toolbar :deep(.el-select) {
    flex: 1;
    min-width: 130px;
    width: auto;
  }

  .account-table-wrap {
    padding-inline: 12px;
  }

  .form-grid {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
