<template>
  <div class="quick-replies-page">
    <div class="page-header">
      <div>
        <h2>快捷指令</h2>
        <p>配置客服常用回复，工作台输入 / 后可搜索并选择填入回复框。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreateDialog">新增指令</el-button>
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form :inline="true" :model="query" @submit.prevent>
        <el-form-item label="关键词">
          <el-input v-model="query.keyword" placeholder="搜索标题、触发词、内容" clearable style="width: 280px" @keyup.enter="fetchQuickReplies" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="query.category" placeholder="如 售前/价格/施工" clearable style="width: 180px" @keyup.enter="fetchQuickReplies" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.enabledOnly" placeholder="全部状态" clearable style="width: 140px" @change="fetchQuickReplies">
            <el-option label="仅启用" value="true" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="fetchQuickReplies">查询</el-button>
          <el-button @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="quickReplies" style="width: 100%">
        <el-table-column label="触发词" width="140">
          <template #default="{ row }">
            <el-tag type="primary" effect="plain">{{ row.shortcut }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column label="回复内容" min-width="320" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="content-preview">{{ row.content }}</span>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.category" type="info" effect="plain">{{ row.category }}</el-tag>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="排序" width="90">
          <template #default="{ row }">{{ row.sortOrder }}</template>
        </el-table-column>
        <el-table-column label="使用" width="90">
          <template #default="{ row }">{{ row.usageCount }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-switch
              :model-value="row.isEnabled"
              :loading="statusLoadingId === row.id"
              @change="(val) => toggleStatus(row, val)"
            />
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
            <el-button link type="danger" @click="deleteQuickReply(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="fetchQuickReplies"
          @current-change="fetchQuickReplies"
        />
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingReply ? '编辑快捷指令' : '新增快捷指令'" width="640px">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" maxlength="100" show-word-limit placeholder="如：价格说明" />
        </el-form-item>
        <el-form-item label="触发词" prop="shortcut">
          <el-input v-model="form.shortcut" maxlength="80" show-word-limit placeholder="如 /price 或 price">
            <template #prepend>/</template>
          </el-input>
          <div class="form-tip">保存时会自动补全 /，客服输入 / 或触发词可搜索。</div>
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="form.category" maxlength="50" show-word-limit placeholder="可选，如 售前、价格、施工" />
        </el-form-item>
        <el-form-item label="回复内容" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            maxlength="10000"
            show-word-limit
            placeholder="请输入选择该指令后填入客服回复框的内容"
          />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="排序">
            <el-input-number v-model="form.sortOrder" :min="0" :max="999999" controls-position="right" />
          </el-form-item>
          <el-form-item label="启用状态">
            <el-switch v-model="form.isEnabled" active-text="启用" inactive-text="停用" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false" :disabled="saving">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveQuickReply">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { adminApi } from '@/api/admin'

const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const formRef = ref(null)
const editingReply = ref(null)
const statusLoadingId = ref('')
const quickReplies = ref([])
const total = ref(0)

const query = reactive({
  keyword: '',
  category: '',
  enabledOnly: '',
  page: 1,
  pageSize: 20
})

const form = reactive({
  title: '',
  shortcut: '',
  content: '',
  category: '',
  sortOrder: 0,
  isEnabled: true
})

const rules = {
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
  shortcut: [{ required: true, message: '请输入触发词', trigger: 'blur' }],
  content: [{ required: true, message: '请输入回复内容', trigger: 'blur' }]
}

const normalizeShortcut = (value) => {
  const clean = String(value || '').trim().replace(/^\/+/, '')
  return clean ? `/${clean}` : ''
}

const fetchQuickReplies = async () => {
  loading.value = true
  try {
    const params = {
      keyword: query.keyword || undefined,
      category: query.category || undefined,
      enabledOnly: query.enabledOnly || undefined,
      page: query.page,
      pageSize: query.pageSize
    }
    const res = await adminApi.getQuickReplies(params)
    const data = res.data?.data || res.data || {}
    quickReplies.value = data.list || []
    total.value = data.total || 0
  } catch (err) {
    ElMessage.error('获取快捷指令失败: ' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

const resetQuery = () => {
  query.keyword = ''
  query.category = ''
  query.enabledOnly = ''
  query.page = 1
  fetchQuickReplies()
}

const resetForm = () => {
  form.title = ''
  form.shortcut = ''
  form.content = ''
  form.category = ''
  form.sortOrder = 0
  form.isEnabled = true
  formRef.value?.clearValidate()
}

const openCreateDialog = () => {
  editingReply.value = null
  resetForm()
  dialogVisible.value = true
}

const openEditDialog = (row) => {
  editingReply.value = row
  form.title = row.title || ''
  form.shortcut = String(row.shortcut || '').replace(/^\/+/, '')
  form.content = row.content || ''
  form.category = row.category || ''
  form.sortOrder = row.sortOrder || 0
  form.isEnabled = Boolean(row.isEnabled)
  dialogVisible.value = true
}

const saveQuickReply = async () => {
  if (saving.value) return
  await formRef.value?.validate()
  const shortcut = normalizeShortcut(form.shortcut)
  if (!shortcut) {
    ElMessage.warning('请输入触发词')
    return
  }
  if (/\s/.test(shortcut)) {
    ElMessage.warning('触发词不能包含空格')
    return
  }

  saving.value = true
  try {
    const payload = {
      title: form.title.trim(),
      shortcut,
      content: form.content.trim(),
      category: form.category.trim(),
      sortOrder: form.sortOrder || 0,
      isEnabled: form.isEnabled
    }
    if (editingReply.value?.id) {
      await adminApi.updateQuickReply(editingReply.value.id, payload)
      ElMessage.success('保存成功')
    } else {
      await adminApi.createQuickReply(payload)
      ElMessage.success('创建成功')
    }
    dialogVisible.value = false
    fetchQuickReplies()
  } catch (err) {
    ElMessage.error('保存失败: ' + (err.message || '未知错误'))
  } finally {
    saving.value = false
  }
}

const toggleStatus = async (row, val) => {
  statusLoadingId.value = row.id
  try {
    await adminApi.updateQuickReplyStatus(row.id, val)
    row.isEnabled = val
    ElMessage.success(val ? '已启用' : '已停用')
  } catch (err) {
    ElMessage.error('状态更新失败: ' + (err.message || '未知错误'))
  } finally {
    statusLoadingId.value = ''
  }
}

const deleteQuickReply = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除快捷指令「${row.shortcut}」？删除后客服将无法再调用。`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    await adminApi.deleteQuickReply(row.id)
    ElMessage.success('删除成功')
    fetchQuickReplies()
  } catch (err) {
    if (err !== 'cancel' && err?.message !== 'cancel') {
      ElMessage.error('删除失败: ' + (err.message || '未知错误'))
    }
  }
}

const formatTime = (time) => time ? dayjs(time).format('YYYY-MM-DD HH:mm') : '-'

onMounted(fetchQuickReplies)
</script>

<style scoped lang="scss">
.quick-replies-page {
  padding: 24px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;

  h2 {
    margin: 0 0 6px;
    color: #1e293b;
    font-size: 24px;
  }

  p {
    margin: 0;
    color: #64748b;
    font-size: 14px;
  }
}

.filter-card {
  margin-bottom: 16px;
}

.table-card {
  :deep(.el-card__body) {
    padding-bottom: 12px;
  }
}

.content-preview {
  color: #475569;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.muted {
  color: #94a3b8;
}

.form-tip {
  margin-top: 6px;
  color: #94a3b8;
  font-size: 12px;
  line-height: 1.4;
}

.form-grid {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 18px;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}
</style>
