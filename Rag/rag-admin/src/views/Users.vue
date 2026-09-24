<template>
  <div class="agent-management">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>坐席管理</span>
          <div class="card-header__actions">
            <el-select v-model="filterRole" placeholder="角色筛选" clearable size="small" style="width: 120px" @change="loadUsers">
              <el-option label="全部" value="" />
              <el-option label="管理员" value="admin" />
              <el-option label="主管" value="supervisor" />
              <el-option label="客服坐席" value="agent" />
              <el-option label="普通用户" value="user" />
            </el-select>
            <el-button plain @click="showSkillTagDialog">管理技能</el-button>
            <el-button type="primary" @click="showAddDialog">
              <el-icon><Plus /></el-icon>
              添加坐席
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="users" v-loading="loading" style="width: 100%">
        <el-table-column label="坐席信息" min-width="190">
          <template #default="{ row }">
            <div class="seat-cell">
              <div class="seat-cell__name">{{ row.username }}</div>
              <div class="seat-cell__email">{{ row.email || '未填写邮箱' }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="90">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" effect="dark">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="绑定账号" min-width="220">
          <template #default="{ row }">
            <div v-if="row.role === 'agent' || row.role === 'supervisor'" class="bound-accounts">
              <template v-if="row.bound_accounts && row.bound_accounts.length > 0">
                <el-tag
                  v-for="acc in row.bound_accounts"
                  :key="acc.binding_id"
                  effect="plain"
                  :style="{ borderColor: acc.channel_meta.color, color: acc.channel_meta.color }"
                  class="bound-account-tag"
                >
                  <span class="bound-account-tag__label">{{ acc.channel_meta.label }}</span>
                  <span class="bound-account-tag__name">{{ acc.phone_number || acc.whatsapp_name || acc.account_name }}</span>
                </el-tag>
              </template>
              <span v-else class="text-muted">未绑定</span>
            </div>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="技能标签" min-width="180">
          <template #default="{ row }">
            <div v-if="row.skills && row.skills.length > 0" class="skill-tags">
              <el-tag v-for="skill in row.skills" :key="skill" size="small" type="info" effect="plain">{{ skill }}</el-tag>
            </div>
            <span v-if="!row.skills || row.skills.length === 0" class="text-muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="接待上限" width="90" align="center">
          <template #default="{ row }">
            {{ row.maxConcurrent || 5 }}
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="170">
          <template #default="{ row }">
            {{ formatDate(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'danger'">
              {{ row.status === 'active' ? '活跃' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.role === 'agent' || row.role === 'supervisor'" size="small" type="primary" plain @click="showBindDialog(row)">绑定账号</el-button>
            <el-button size="small" @click="editUser(row)">编辑</el-button>
            <el-button size="small" :type="row.status === 'active' ? 'warning' : 'success'" @click="toggleStatus(row)">
              {{ row.status === 'active' ? '禁用' : '启用' }}
            </el-button>
            <el-button size="small" type="danger" @click="deleteUser(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 添加/编辑坐席对话框 -->
    <el-dialog v-model="dialogVisible" :title="isEdit ? '编辑坐席' : '添加坐席'" width="500px">
      <el-form :model="agentForm" :rules="formRules" ref="formRef" label-width="100px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="agentForm.username" :disabled="isEdit" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item v-if="!isEdit" label="密码" prop="password">
          <el-input v-model="agentForm.password" type="password" show-password placeholder="请输入密码" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="agentForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="agentForm.role" style="width: 100%">
            <el-option label="管理员" value="admin" />
            <el-option label="主管" value="supervisor" />
            <el-option label="客服坐席" value="agent" />
            <el-option label="普通用户" value="user" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="agentForm.role === 'agent' || agentForm.role === 'supervisor'" label="技能标签">
          <div class="skill-select-row">
            <el-select
              v-model="agentForm.skills"
              multiple
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入技能标签"
              style="width: 100%"
              :loading="skillTagLoading"
            >
              <el-option
                v-for="tag in skillTags"
                :key="tag.id || tag.name"
                :label="tag.name"
                :value="tag.name"
              />
            </el-select>
            <el-button plain @click="showSkillTagDialog">管理</el-button>
          </div>
        </el-form-item>
        <el-form-item v-if="agentForm.role === 'agent' || agentForm.role === 'supervisor'" label="最大接待数">
          <el-input-number v-model="agentForm.maxConcurrent" :min="1" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="agentForm.status">
            <el-radio label="active">活跃</el-radio>
            <el-radio label="disabled">禁用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>

    <!-- 技能标签管理对话框 -->
    <el-dialog v-model="skillTagDialogVisible" title="技能标签管理" width="520px">
      <div class="skill-tag-manager">
        <div class="skill-tag-add">
          <el-input
            v-model="newSkillTagName"
            placeholder="输入新的技能标签"
            maxlength="50"
            show-word-limit
            @keyup.enter="createSkillTag"
          />
          <el-button type="primary" :loading="skillTagSaving" @click="createSkillTag">添加</el-button>
        </div>
        <div v-loading="skillTagLoading" class="skill-tag-list">
          <el-tag
            v-for="tag in skillTags"
            :key="tag.id"
            closable
            effect="plain"
            @close="removeSkillTag(tag)"
          >
            {{ tag.name }}
          </el-tag>
          <el-empty v-if="!skillTagLoading && skillTags.length === 0" description="暂无技能标签" :image-size="60" />
        </div>
      </div>
    </el-dialog>

    <!-- 绑定账号对话框 -->
    <el-dialog v-model="bindDialogVisible" title="绑定账号" width="700px" class="bind-dialog">
      <div class="bind-dialog__content">
        <!-- 当前绑定的账号 -->
        <div class="bind-section">
          <div class="bind-section__title">已绑定账号</div>
          <div v-if="currentBindings.length > 0" class="bind-list">
            <div v-for="acc in currentBindings" :key="getBindingId(acc)" class="bind-item">
              <div class="bind-item__info">
                <el-tag
                  effect="dark"
                  :style="{ backgroundColor: acc.channel_meta.color, borderColor: acc.channel_meta.color }"
                  size="small"
                >
                  {{ acc.channel_meta.label }}
                </el-tag>
                <span class="bind-item__name">{{ acc.account_name }}</span>
                <span v-if="acc.phone_number" class="bind-item__detail">{{ acc.phone_number }}</span>
                <span v-if="acc.whatsapp_name && !acc.phone_number" class="bind-item__detail">{{ acc.whatsapp_name }}</span>
              </div>
              <el-button size="small" type="danger" plain @click="unbindAccount(acc)">解绑</el-button>
            </div>
          </div>
          <el-empty v-else description="暂无绑定账号" :image-size="60" />
        </div>

        <!-- 添加绑定 -->
        <div class="bind-section">
          <div class="bind-section__title">添加绑定</div>
          <div class="bind-add">
            <el-select v-model="bindChannel" placeholder="选择渠道" style="width: 140px" @change="loadAvailableAccounts">
              <el-option label="WhatsApp" value="whatsapp" />
              <el-option label="抖音" value="douyin" disabled />
              <el-option label="微信" value="wechat" disabled />
            </el-select>
            <el-select
              v-model="bindAccountId"
              placeholder="选择账号（可多选）"
              style="width: 320px"
              :loading="availableLoading"
              :disabled="!bindChannel || filteredAvailableAccounts.length === 0"
              filterable
              multiple
              collapse-tags
              collapse-tags-tooltip
            >
              <el-option
                v-for="acc in filteredAvailableAccounts"
                :key="acc.id"
                :label="`${acc.account_name} - ${acc.phone_number || acc.whatsapp_name || '未绑定号码'}`"
                :value="acc.id"
              >
                <span>{{ acc.account_name }} - {{ acc.phone_number || acc.whatsapp_name || '未绑定号码' }}</span>
                <span v-if="acc.bound_to && acc.bound_to.length > 0" style="color: #909399; font-size: 12px; margin-left: 8px">
                  （已绑：{{ acc.bound_to.map(s => s.username).join('、') }}）
                </span>
              </el-option>
            </el-select>
            <el-button
              type="primary"
              :disabled="bindAccountId.length === 0"
              :loading="binding"
              @click="bindAccount"
            >
              绑定
            </el-button>
          </div>
          <div v-if="bindChannel && availableAccounts.length > 0 && filteredAvailableAccounts.length === 0 && !availableLoading" class="bind-add__hint">
            <el-alert type="success" :closable="false" show-icon>
              <template #title>该渠道的所有账号已绑定</template>
              如需绑定其他账号，请先在「渠道管理」中添加
            </el-alert>
          </div>
          <div v-else-if="bindChannel && availableAccounts.length === 0 && !availableLoading" class="bind-add__hint">
            <el-alert type="info" :closable="false" show-icon>
              <template #title>当前没有可绑定的 {{ channelLabelMap[bindChannel] || bindChannel }} 账号</template>
              请先在「渠道管理」中添加并激活账号
            </el-alert>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

const users = ref([])
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)
const filterRole = ref('')
const skillTags = ref([])
const skillTagLoading = ref(false)
const skillTagSaving = ref(false)
const skillTagDialogVisible = ref(false)
const newSkillTagName = ref('')

const agentForm = reactive({
  id: null,
  username: '',
  password: '',
  email: '',
  role: 'agent',
  status: 'active',
  skills: [],
  maxConcurrent: 5
})

const formRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 2, max: 30, message: '用户名长度为 2-30 个字符', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 个字符', trigger: 'blur' }
  ],
  email: [
    { type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' }
  ],
  role: [
    { required: true, message: '请选择角色', trigger: 'change' }
  ]
}

// ========== 绑定账号相关状态 ==========
const bindDialogVisible = ref(false)
const currentBindings = ref([])
const bindChannel = ref('')
const bindAccountId = ref([])
const availableAccounts = ref([])
const availableLoading = ref(false)
const binding = ref(false)
const currentSeatId = ref(null)
const currentSeatName = ref('')

const channelLabelMap = {
  whatsapp: 'WhatsApp',
  douyin: '抖音',
  wechat: '微信'
}

const getBindingId = (binding) => binding?.binding_id || binding?.id

// 过滤掉当前坐席已绑定的账号（避免重复选择）
const filteredAvailableAccounts = computed(() => {
  const boundIds = new Set(currentBindings.value.map(b => b.account_id))
  return availableAccounts.value.filter(acc => !boundIds.has(acc.id))
})

const normalizeSkills = (skills = []) => {
  return [...new Set(
    skills
      .map(skill => String(skill || '').trim())
      .filter(Boolean)
  )]
}

// 角色标签映射
const roleLabel = (role) => {
  const map = { admin: '管理员', supervisor: '主管', agent: '客服坐席', user: '普通用户' }
  return map[role] || role
}

// 角色标签颜色
const roleTagType = (role) => {
  const map = { admin: 'danger', supervisor: 'warning', agent: 'primary', user: 'info' }
  return map[role] || 'info'
}

// 格式化日期
const formatDate = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 加载用户列表
const loadUsers = async () => {
  loading.value = true
  try {
    const params = {}
    if (filterRole.value) params.role = filterRole.value
    const res = await adminApi.getUsers(params)
    users.value = res.data?.data || []
  } catch (error) {
    ElMessage.error('获取坐席列表失败')
  } finally {
    loading.value = false
  }
}

const loadSkillTags = async () => {
  skillTagLoading.value = true
  try {
    const res = await adminApi.getSeatSkillTags()
    skillTags.value = res.data?.data || []
  } catch (error) {
    ElMessage.error('获取技能标签失败')
  } finally {
    skillTagLoading.value = false
  }
}

const showSkillTagDialog = async () => {
  newSkillTagName.value = ''
  skillTagDialogVisible.value = true
  await loadSkillTags()
}

const createSkillTag = async () => {
  const name = newSkillTagName.value.trim()
  if (!name) {
    ElMessage.warning('请输入技能标签')
    return
  }

  skillTagSaving.value = true
  try {
    await adminApi.createSeatSkillTag(name)
    newSkillTagName.value = ''
    ElMessage.success('技能标签已保存')
    await loadSkillTags()
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || '保存技能标签失败')
  } finally {
    skillTagSaving.value = false
  }
}

const removeSkillTag = async (tag) => {
  try {
    await ElMessageBox.confirm(
      `确定删除技能标签「${tag.name}」吗？删除后会从所有坐席已选技能中移除。`,
      '删除确认',
      { type: 'warning' }
    )
    await adminApi.deleteSeatSkillTag(tag.id)
    agentForm.skills = normalizeSkills(agentForm.skills).filter(skill => skill !== tag.name)
    ElMessage.success('技能标签已删除')
    await loadSkillTags()
    await loadUsers()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(error?.response?.data?.message || '删除技能标签失败')
    }
  }
}

const ensureFormSkillTags = async () => {
  agentForm.skills = normalizeSkills(agentForm.skills)
  const existingNames = new Set(skillTags.value.map(tag => tag.name))
  const newNames = agentForm.skills.filter(skill => !existingNames.has(skill))
  if (newNames.length === 0) return

  await Promise.all(newNames.map(name => adminApi.createSeatSkillTag(name)))
  await loadSkillTags()
}

// 显示添加对话框
const showAddDialog = () => {
  isEdit.value = false
  Object.assign(agentForm, {
    id: null,
    username: '',
    password: '',
    email: '',
    role: 'agent',
    status: 'active',
    skills: [],
    maxConcurrent: 5
  })
  dialogVisible.value = true
}

// 编辑用户
const editUser = (row) => {
  isEdit.value = true
  Object.assign(agentForm, {
    id: row.id,
    username: row.username,
    password: '',
    email: row.email || '',
    role: row.role,
    status: row.status,
    skills: row.skills || [],
    maxConcurrent: row.maxConcurrent || 5
  })
  dialogVisible.value = true
}

// 保存用户（添加或编辑）
const saveUser = async () => {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
    saving.value = true
    await ensureFormSkillTags()

    if (isEdit.value) {
      // 编辑：调用更新接口
      const updateData = {
        role: agentForm.role,
        status: agentForm.status,
        skills: agentForm.skills,
        maxConcurrent: agentForm.maxConcurrent
      }
      await adminApi.updateUser(agentForm.id, updateData)
      ElMessage.success('更新成功')
    } else {
      // 添加：调用注册接口
      const registerData = {
        username: agentForm.username,
        password: agentForm.password,
        email: agentForm.email,
        role: agentForm.role
      }
      const res = await adminApi.createAgent(registerData)
      // 注册成功后，如果需要设置 skills/maxConcurrent，再调用更新接口
      if (agentForm.skills.length > 0 || agentForm.maxConcurrent !== 5 || agentForm.status !== 'active') {
        const userId = res.data?.data?.user?.id
        if (userId) {
          await adminApi.updateUser(userId, {
            skills: agentForm.skills,
            maxConcurrent: agentForm.maxConcurrent,
            status: agentForm.status
          })
        }
      }
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    loadUsers()
  } catch (error) {
    if (error?.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else if (error?.message) {
      ElMessage.error(error.message)
    } else {
      ElMessage.error('操作失败')
    }
  } finally {
    saving.value = false
  }
}

// 切换状态
const toggleStatus = async (row) => {
  try {
    const newStatus = row.status === 'active' ? 'disabled' : 'active'
    await adminApi.updateUser(row.id, { status: newStatus })
    ElMessage.success(`${newStatus === 'active' ? '启用' : '禁用'}成功`)
    loadUsers()
  } catch (error) {
    ElMessage.error('操作失败')
  }
}

// 删除用户
const deleteUser = async (row) => {
  try {
    await ElMessageBox.confirm(`确定要删除坐席 "${row.username}" 吗？`, '提示', {
      type: 'warning'
    })
    await adminApi.deleteUser(row.id)
    ElMessage.success('删除成功')
    loadUsers()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

// ========== 绑定账号功能 ==========

// 显示绑定账号对话框
const showBindDialog = async (row) => {
  currentSeatId.value = row.id
  currentSeatName.value = row.username
  currentBindings.value = row.bound_accounts || []
  bindChannel.value = ''
  bindAccountId.value = []
  availableAccounts.value = []
  bindDialogVisible.value = true

  try {
    const res = await adminApi.getSeatBindings(row.id, { sync: true })
    currentBindings.value = res.data?.data || []
  } catch (error) {
    console.warn('刷新当前绑定账号失败:', error)
  }
}

// 加载可绑定的账号
const loadAvailableAccounts = async () => {
  if (!bindChannel.value) return
  bindAccountId.value = []
  availableLoading.value = true
  try {
    const res = await adminApi.getAvailableAccounts(bindChannel.value, {
      sync: bindChannel.value === 'whatsapp'
    })
    availableAccounts.value = res.data?.data || []
  } catch (error) {
    ElMessage.error('获取可绑定账号列表失败')
    availableAccounts.value = []
  } finally {
    availableLoading.value = false
  }
}

// 绑定账号（支持批量多选）
const bindAccount = async () => {
  if (!currentSeatId.value || bindAccountId.value.length === 0) return
  binding.value = true
  try {
    const results = []
    for (const accId of bindAccountId.value) {
      try {
        const res = await adminApi.bindAccountToSeat(currentSeatId.value, accId)
        const newBinding = res.data?.data
        if (newBinding) {
          results.push(newBinding)
        }
      } catch (err) {
        // 单个绑定失败（如重复绑定），继续处理其他
        const msg = err?.response?.data?.message || ''
        if (!msg.includes('已绑定到此坐席')) {
          ElMessage.warning(`账号 ${accId} 绑定失败: ${msg}`)
        }
      }
    }
    if (results.length > 0) {
      ElMessage.success(`成功绑定 ${results.length} 个账号`)
      currentBindings.value.push(...results)
    }
    // 重置选择
    bindAccountId.value = []
    // 重新加载可用账号
    await loadAvailableAccounts()
    // 同时刷新用户列表，更新表格中的绑定显示
    loadUsers()
  } catch (error) {
    const msg = error?.response?.data?.message || '绑定失败'
    ElMessage.error(msg)
  } finally {
    binding.value = false
  }
}

// 解绑账号
const unbindAccount = async (acc) => {
  try {
    await ElMessageBox.confirm(
      `确定要解绑坐席「${currentSeatName.value}」的 ${acc.channel_meta.label} 账号「${acc.account_name}」吗？`,
      '解绑确认',
      { type: 'warning' }
    )
    const bindingId = getBindingId(acc)
    if (!bindingId) {
      ElMessage.error('解绑失败：绑定记录 ID 缺失')
      return
    }
    await adminApi.unbindAccount(bindingId)
    ElMessage.success('账号已解绑')
    // 从当前绑定列表移除
    currentBindings.value = currentBindings.value.filter(b => getBindingId(b) !== bindingId)
    // 刷新用户列表
    loadUsers()
    // 重新加载可用账号（解绑后该账号变为可用）
    if (bindChannel.value) {
      await loadAvailableAccounts()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('解绑失败')
    }
  }
}

// 初始化加载
loadUsers()
loadSkillTags()
</script>

<style scoped lang="scss">
.agent-management {
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    &__actions {
      display: flex;
      gap: 12px;
    }
  }

  .text-muted {
    color: #c0c4cc;
    font-size: 13px;
  }

  .seat-cell {
    line-height: 1.45;

    &__name {
      font-weight: 600;
      color: #303133;
    }

    &__email {
      margin-top: 2px;
      font-size: 12px;
      color: #909399;
    }
  }

  .skill-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .skill-select-row {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
  }

  .skill-tag-manager {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .skill-tag-add {
    display: flex;
    gap: 8px;
  }

  .skill-tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 72px;
    padding: 12px;
    border: 1px solid #e4e7ed;
    border-radius: 6px;
    background: #fafafa;
  }

  .bound-accounts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .bound-account-tag {
    font-size: 12px;

    &__label {
      font-weight: 600;
      margin-right: 4px;
    }

    &__name {
      opacity: 0.85;
    }
  }
}

.bind-dialog {
  .bind-dialog__content {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .bind-section {
    &__title {
      font-size: 14px;
      font-weight: 600;
      color: #303133;
      margin-bottom: 12px;
      padding-left: 8px;
      border-left: 3px solid #409EFF;
    }
  }

  .bind-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .bind-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 6px;
    background: #f5f7fa;
    border: 1px solid #e4e7ed;
    transition: background 0.2s;

    &:hover {
      background: #ecf0f5;
    }

    &__info {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    &__name {
      font-size: 14px;
      font-weight: 500;
      color: #303133;
    }

    &__detail {
      font-size: 12px;
      color: #909399;
    }
  }

  .bind-add {
    display: flex;
    align-items: center;
    gap: 12px;

    &__hint {
      margin-top: 8px;
    }
  }
}
</style>
