<template>
  <div class="agent-manage-view">
    <!-- 顶部操作栏 -->
    <div class="agent-manage-view__toolbar">
      <h3 class="agent-manage-view__title">坐席管理</h3>
      <div class="agent-manage-view__actions">
        <el-button :icon="Upload" plain @click="handleImport">批量导入</el-button>
        <el-button :icon="Download" plain @click="handleExport">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="handleAdd">新增坐席</el-button>
      </div>
    </div>

    <!-- 坐席列表 -->
    <el-card shadow="never" class="agent-manage-view__table-card">
      <el-table
        v-loading="loading"
        :data="filteredList"
        border
        style="width: 100%"
        :header-cell-style="{ background: '#fafafa' }"
      >
        <el-table-column prop="name" label="姓名" width="120" fixed>
          <template #default="{ row }">
            <div class="agent-manage-view__name-cell">
              <el-avatar :size="32" :style="{ background: getAvatarColor(row.name) }">
                {{ row.name.charAt(0) }}
              </el-avatar>
              <span>{{ row.name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="role" label="角色" width="100">
          <template #default="{ row }">
            <el-tag :type="getRoleTagType(row.role)" size="small" effect="dark">
              {{ row.role }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="技能标签" min-width="200">
          <template #default="{ row }">
            <el-tag
              v-for="skill in row.skills"
              :key="skill"
              size="small"
              effect="plain"
              class="agent-manage-view__skill-tag"
            >
              {{ skill }}
            </el-tag>
            <span v-if="row.skills.length === 0" class="agent-manage-view__no-skill">暂无</span>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'online' ? 'success' : 'info'" size="small" effect="light">
              {{ row.status === 'online' ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="当前接待/上限" width="140" align="center">
          <template #default="{ row }">
            <span :class="{ 'agent-manage-view__concurrent--full': row.current >= row.maxConcurrent }">
              {{ row.current }} / {{ row.maxConcurrent }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="lastActive" label="最后活跃" width="160" />
        <el-table-column label="操作" width="80" fixed="right" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" :icon="Edit" @click="handleEdit(row)">
              编辑
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增/编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingAgent?.id ? '编辑坐席' : '新增坐席'"
      width="520px"
    >
      <el-form
        ref="agentFormRef"
        :model="agentForm"
        :rules="agentRules"
        label-width="100px"
      >
        <el-form-item label="姓名" prop="name">
          <el-input v-model="agentForm.name" placeholder="请输入坐席姓名" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="agentForm.role" placeholder="请选择角色" style="width: 100%">
            <el-option label="超管" value="超管" />
            <el-option label="主管" value="主管" />
            <el-option label="客服" value="客服" />
          </el-select>
        </el-form-item>
        <el-form-item label="技能标签" prop="skills">
          <el-select
            v-model="agentForm.skills"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入技能标签"
            style="width: 100%"
          >
            <el-option label="售前咨询" value="售前咨询" />
            <el-option label="售后处理" value="售后处理" />
            <el-option label="技术支持" value="技术支持" />
            <el-option label="投诉处理" value="投诉处理" />
            <el-option label="VIP服务" value="VIP服务" />
            <el-option label="英语客服" value="英语客服" />
          </el-select>
        </el-form-item>
        <el-form-item label="最大接待数" prop="maxConcurrent">
          <el-input-number v-model="agentForm.maxConcurrent" :min="1" :max="50" style="width: 200px" />
          <span class="agent-manage-view__hint">个会话</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSave">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Plus,
  Edit,
  Upload,
  Download
} from '@element-plus/icons-vue'

const loading = ref(false)
const dialogVisible = ref(false)
const submitting = ref(false)
const editingAgent = ref(null)
const agentFormRef = ref(null)

// Mock 坐席数据
const agentList = ref([
  {
    id: 1,
    name: '张三',
    role: '超管',
    skills: ['售前咨询', 'VIP服务', '英语客服'],
    status: 'online',
    current: 5,
    maxConcurrent: 10,
    lastActive: '2026-07-06 14:30:00'
  },
  {
    id: 2,
    name: '李四',
    role: '主管',
    skills: ['售前咨询', '售后处理'],
    status: 'online',
    current: 8,
    maxConcurrent: 10,
    lastActive: '2026-07-06 14:28:00'
  },
  {
    id: 3,
    name: '王五',
    role: '客服',
    skills: ['售后处理', '技术支持'],
    status: 'online',
    current: 3,
    maxConcurrent: 8,
    lastActive: '2026-07-06 14:25:00'
  },
  {
    id: 4,
    name: '赵六',
    role: '客服',
    skills: ['售前咨询'],
    status: 'offline',
    current: 0,
    maxConcurrent: 8,
    lastActive: '2026-07-05 18:00:00'
  },
  {
    id: 5,
    name: '钱七',
    role: '客服',
    skills: ['投诉处理', 'VIP服务'],
    status: 'online',
    current: 6,
    maxConcurrent: 6,
    lastActive: '2026-07-06 14:20:00'
  }
])

const filteredList = computed(() => agentList.value)

const agentForm = reactive({
  name: '',
  role: '客服',
  skills: [],
  maxConcurrent: 8
})

const agentRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
  maxConcurrent: [{ required: true, message: '请输入最大接待数', trigger: 'blur' }]
}

const colors = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399', '#9c27b0']

const getAvatarColor = (name) => {
  const index = name.charCodeAt(0) % colors.length
  return colors[index]
}

const getRoleTagType = (role) => {
  const map = { '超管': 'danger', '主管': 'warning', '客服': 'info' }
  return map[role] || 'info'
}

const handleAdd = () => {
  editingAgent.value = null
  Object.assign(agentForm, {
    name: '',
    role: '客服',
    skills: [],
    maxConcurrent: 8
  })
  dialogVisible.value = true
}

const handleEdit = (row) => {
  editingAgent.value = row
  Object.assign(agentForm, {
    name: row.name,
    role: row.role,
    skills: [...row.skills],
    maxConcurrent: row.maxConcurrent
  })
  dialogVisible.value = true
}

const handleSave = async () => {
  if (!agentFormRef.value) return
  try {
    await agentFormRef.value.validate()
    submitting.value = true

    setTimeout(() => {
      if (editingAgent.value?.id) {
        // 编辑
        const idx = agentList.value.findIndex((a) => a.id === editingAgent.value.id)
        if (idx > -1) {
          agentList.value[idx] = {
            ...agentList.value[idx],
            name: agentForm.name,
            role: agentForm.role,
            skills: [...agentForm.skills],
            maxConcurrent: agentForm.maxConcurrent
          }
        }
        ElMessage.success('修改成功')
      } else {
        // 新增
        agentList.value.push({
          id: Date.now(),
          name: agentForm.name,
          role: agentForm.role,
          skills: [...agentForm.skills],
          status: 'offline',
          current: 0,
          maxConcurrent: agentForm.maxConcurrent,
          lastActive: '-'
        })
        ElMessage.success('新增成功')
      }
      submitting.value = false
      dialogVisible.value = false
    }, 500)
  } catch (error) {
    // 验证失败
  }
}

const handleImport = () => {
  ElMessage.info('批量导入功能开发中')
}

const handleExport = () => {
  ElMessage.success('导出中，请稍候...')
}

onMounted(() => {
  loading.value = true
  setTimeout(() => {
    loading.value = false
  }, 300)
})
</script>

<style scoped lang="scss">
.agent-manage-view {
  padding: 20px;

  &__toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  &__title {
    font-size: 18px;
    font-weight: 600;
    color: $text-primary;
    margin: 0;
  }

  &__actions {
    display: flex;
    gap: 8px;
  }

  &__table-card {
    border-radius: $radius-base;
  }

  &__name-cell {
    display: flex;
    align-items: center;
    gap: 8px;

    :deep(.el-avatar) {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }
  }

  &__skill-tag {
    margin: 2px 4px 2px 0;
  }

  &__no-skill {
    font-size: 13px;
    color: $text-placeholder;
  }

  &__concurrent--full {
    color: $danger-color;
    font-weight: 600;
  }

  &__hint {
    margin-left: 8px;
    font-size: 13px;
    color: $text-secondary;
  }
}
</style>
