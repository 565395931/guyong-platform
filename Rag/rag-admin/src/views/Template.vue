<template>
  <div class="templates">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>分块模板管理</span>
          <el-button type="primary" @click="showCreateDialog">
            <el-icon><Plus /></el-icon>
            新增模板
          </el-button>
        </div>
      </template>
      
      <el-table :data="templates" style="width: 100%" v-loading="loading">
        <el-table-column prop="name" label="模板名称" min-width="150" />
        <el-table-column prop="templateId" label="模板ID" min-width="120" />
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column prop="isDefault" label="默认模板" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.isDefault" type="success">是</el-tag>
            <el-tag v-else type="info">否</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="updateTime" label="更新时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.updateTime) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="showDetailDialog(row)">查看</el-button>
            <el-button size="small" type="primary" link @click="showEditDialog(row)" :disabled="row.templateId === 'default'">编辑</el-button>
            <el-button size="small" type="warning" link @click="setDefault(row)" :disabled="row.isDefault">设为默认</el-button>
            <el-button size="small" type="danger" link @click="deleteTemplate(row)" :disabled="row.templateId === 'default'">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    
    <!-- 新增/编辑模板对话框 -->
    <el-dialog 
      v-model="dialogVisible" 
      :title="dialogMode === 'create' ? '新增模板' : '编辑模板'" 
      width="700px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="formData" :rules="formRules" label-width="120px">
        <el-form-item label="模板名称" prop="name">
          <el-input v-model="formData.name" placeholder="请输入模板名称" />
        </el-form-item>
        
        <el-form-item label="模板ID" prop="templateId" v-if="dialogMode === 'create'">
          <el-input v-model="formData.templateId" placeholder="只允许字母、数字、下划线" />
        </el-form-item>
        
        <el-form-item label="模板描述" prop="description">
          <el-input v-model="formData.description" type="textarea" :rows="2" placeholder="请输入模板描述" />
        </el-form-item>
        
        <el-divider content-position="left">分块配置</el-divider>
        
        <el-form-item label="标题拆分层级" style="margin-bottom: 35px;">
          <div class="config-tip">(按几级标题拆分，层级越高拆分越细)</div>
          <div class="form-item-content">
            <div class="control-row">
              <el-slider v-model="formData.config.maxHeadingLevel" :min="1" :max="4" show-stops :marks="headingMarks" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="最大分块大小">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number v-model="formData.config.maxChunkSize" :min="100" :max="2000" :step="100" />
              <span class="unit-label">字符</span>
            </div>
            <div class="config-tip">超长内容的拆分阈值，100-2000</div>
          </div>
        </el-form-item>
        
        <el-form-item label="重叠字符数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number v-model="formData.config.chunkOverlap" :min="0" :max="500" :step="20" />
              <span class="unit-label">字符</span>
            </div>
            <div class="config-tip">拆分时的重叠长度，保持上下文连贯</div>
          </div>
        </el-form-item>
        
        <el-form-item label="短列表最大项数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number v-model="formData.config.maxListLength" :min="1" :max="50" :step="1" />
              <span class="unit-label">项</span>
            </div>
            <div class="config-tip">短列表整块保留的最大项数</div>
          </div>
        </el-form-item>
        
        <el-form-item label="表格整块保留">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch v-model="formData.config.keepTableWhole" />
            </div>
            <div class="config-tip">表格内容不与其他内容混切</div>
          </div>
        </el-form-item>
        
        <el-form-item label="列表整块保留">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch v-model="formData.config.keepListWhole" />
            </div>
            <div class="config-tip">短列表内容不与其他内容混切</div>
          </div>
        </el-form-item>
        
        <el-form-item label="注入章节路径">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch v-model="formData.config.injectHeadingPath" />
            </div>
            <div class="config-tip">每个分块自动拼接所属章节路径</div>
          </div>
        </el-form-item>
      </el-form>
      
      <template #footer>
        <el-button @click="dialogVisible = false" :disabled="submitting">取消</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitting">确定</el-button>
      </template>
    </el-dialog>
    
    <!-- 查看模板详情对话框 -->
    <el-dialog 
      v-model="detailDialogVisible" 
      title="模板详情" 
      width="500px"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="模板名称">{{ currentTemplate.name }}</el-descriptions-item>
        <el-descriptions-item label="模板ID">{{ currentTemplate.templateId }}</el-descriptions-item>
        <el-descriptions-item label="描述">{{ currentTemplate.description || '无' }}</el-descriptions-item>
        <el-descriptions-item label="是否默认">
          <el-tag v-if="currentTemplate.isDefault" type="success">默认模板</el-tag>
          <el-tag v-else type="info">普通模板</el-tag>
        </el-descriptions-item>
      </el-descriptions>
      
      <el-divider content-position="left">分块配置</el-divider>
      
      <el-descriptions :column="2" border>
        <el-descriptions-item label="标题拆分层级">{{ currentTemplate.config?.maxHeadingLevel }}级</el-descriptions-item>
        <el-descriptions-item label="最大分块大小">{{ currentTemplate.config?.maxChunkSize }}字符</el-descriptions-item>
        <el-descriptions-item label="重叠字符数">{{ currentTemplate.config?.chunkOverlap }}字符</el-descriptions-item>
        <el-descriptions-item label="短列表最大项数">{{ currentTemplate.config?.maxListLength }}项</el-descriptions-item>
        <el-descriptions-item label="表格整块保留">
          <el-tag :type="currentTemplate.config?.keepTableWhole ? 'success' : 'info'">
            {{ currentTemplate.config?.keepTableWhole ? '是' : '否' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="列表整块保留">
          <el-tag :type="currentTemplate.config?.keepListWhole ? 'success' : 'info'">
            {{ currentTemplate.config?.keepListWhole ? '是' : '否' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="注入章节路径">
          <el-tag :type="currentTemplate.config?.injectHeadingPath ? 'success' : 'info'">
            {{ currentTemplate.config?.injectHeadingPath ? '是' : '否' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="分块策略">{{ currentTemplate.config?.splitStrategy }}</el-descriptions-item>
      </el-descriptions>
      
      <template #footer>
        <el-button type="primary" @click="detailDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

const templates = ref([])
const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const detailDialogVisible = ref(false)
const dialogMode = ref('create') // create 或 edit
const formRef = ref(null)
const currentTemplate = ref({})

// 标题层级标记
const headingMarks = {
  1: '1级',
  2: '2级',
  3: '3级',
  4: '4级'
}

// 表单数据
const formData = reactive({
  name: '',
  templateId: '',
  description: '',
  config: {
    maxHeadingLevel: 3,
    maxChunkSize: 800,
    chunkOverlap: 120,
    maxListLength: 10,
    keepTableWhole: true,
    keepListWhole: true,
    injectHeadingPath: true,
    splitStrategy: 'heading_driven'
  }
})

// 表单校验规则
const formRules = {
  name: [
    { required: true, message: '请输入模板名称', trigger: 'blur' },
    { min: 2, max: 50, message: '名称长度 2-50 字符', trigger: 'blur' }
  ],
  templateId: [
    { required: true, message: '请输入模板ID', trigger: 'blur' },
    { pattern: /^[a-zA-Z0-9_]+$/, message: '只允许字母、数字、下划线', trigger: 'blur' }
  ]
}

onMounted(async () => {
  loadTemplates()
})

// 加载模板列表
const loadTemplates = async () => {
  loading.value = true
  try {
    const res = await adminApi.getTemplates()
    if (res.data.success) {
      templates.value = res.data.data.templates || []
    } else {
      ElMessage.warning(res.data.message || '获取模板列表失败')
    }
  } catch (error) {
    ElMessage.error('获取模板列表失败: ' + (error.message || '未知错误'))
    templates.value = []
  } finally {
    loading.value = false
  }
}

// 显示新增对话框
const showCreateDialog = () => {
  dialogMode.value = 'create'
  resetFormData()
  dialogVisible.value = true
}

// 显示编辑对话框
const showEditDialog = (row) => {
  dialogMode.value = 'edit'
  formData.name = row.name
  formData.templateId = row.templateId
  formData.description = row.description || ''
  formData.config = { ...row.config }
  dialogVisible.value = true
}

// 显示详情对话框
const showDetailDialog = (row) => {
  currentTemplate.value = row
  detailDialogVisible.value = true
}

// 重置表单数据
const resetFormData = () => {
  formData.name = ''
  formData.templateId = ''
  formData.description = ''
  formData.config = {
    maxHeadingLevel: 3,
    maxChunkSize: 800,
    chunkOverlap: 120,
    maxListLength: 10,
    keepTableWhole: true,
    keepListWhole: true,
    injectHeadingPath: true,
    splitStrategy: 'heading_driven'
  }
  if (formRef.value) {
    formRef.value.resetFields()
  }
}

// 提交表单
const handleSubmit = async () => {
  try {
    await formRef.value.validate()
    submitting.value = true
    
    const submitData = {
      name: formData.name,
      templateId: formData.templateId,
      description: formData.description,
      config: formData.config
    }
    
    let res
    if (dialogMode.value === 'create') {
      res = await adminApi.createTemplate(submitData)
    } else {
      res = await adminApi.updateTemplate(formData.templateId, submitData)
    }
    
    if (res.data.success) {
      ElMessage.success(dialogMode.value === 'create' ? '模板创建成功' : '模板更新成功')
      dialogVisible.value = false
      loadTemplates()
    } else {
      ElMessage.error(res.data.message || '操作失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(error.message || '操作失败')
    }
  } finally {
    submitting.value = false
  }
}

// 设置默认模板
const setDefault = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定要将 "${row.name}" 设置为默认模板吗？`,
      '设置默认模板',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    const res = await adminApi.setDefaultTemplate(row.templateId)
    if (res.data.success) {
      ElMessage.success('默认模板设置成功')
      loadTemplates()
    } else {
      ElMessage.error(res.data.message || '设置失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(error.message || '设置失败')
    }
  }
}

// 删除模板
const deleteTemplate = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除模板 "${row.name}" 吗？删除后无法恢复。`,
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    const res = await adminApi.deleteTemplate(row.templateId)
    if (res.data.success) {
      ElMessage.success('删除成功')
      loadTemplates()
    } else {
      ElMessage.error(res.data.message || '删除失败')
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(error.message || '删除失败')
    }
  }
}

// 时间格式化
const formatTime = (timestamp) => {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<style scoped lang="scss">
.templates {
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  // 表单样式优化
  .el-form {
    .el-form-item {
      margin-bottom: 18px;
    }
    
    // 表单项内容容器
    .form-item-content {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      
      // 控件行（控件 + 单位标签）
      .control-row {
        display: flex;
        align-items: center;
        gap: 10px;
        
        // 数字输入框
        .el-input-number {
          width: 180px;
        }
        
        // 滑块占满整行
        .el-slider {
          flex: 1;
        }
        
        // 开关
        .el-switch {
          // 默认大小
        }
        
        // 单位标签
        .unit-label {
          color: #606266;
          font-size: 14px;
        }
      }
      
      // 配置提示文字（独立一行）
      .config-tip {
        font-size: 12px;
        color: #909399;
        line-height: 1.5;
        padding-left: 0;
      }
    }
  }
  
  .el-divider {
    margin: 20px 0 15px;
  }
  
  // 对话框内表单样式
  :deep(.el-dialog__body) {
    padding: 15px 25px;
    
    .el-form-item__label {
      width: 120px !important;
      text-align: right;
      padding-right: 15px;
    }
    
    .el-form-item__content {
      flex: 1;
      display: flex;
    }
  }
}
</style>