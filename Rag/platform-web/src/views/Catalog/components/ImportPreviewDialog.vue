<template>
  <el-dialog :model-value="modelValue" title="导入产品与报价文件" width="700px" @close="close">
    <el-alert title="文件只会先解析为预览；确认后才写入新的草稿版本。" type="info" :closable="false" />
    <el-upload class="upload-box" drag :auto-upload="false" :limit="1" accept=".md,.xlsx,.xls" :on-change="handleChange" :on-remove="handleRemove">
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
      <div class="el-upload__text">拖入文件或<em>点击选择</em></div>
      <template #tip><div class="el-upload__tip">支持 Markdown 和具有 Products、SKUs、Prices、Freight 工作表的 Excel</div></template>
    </el-upload>
    <el-button :loading="loading" :disabled="!file" @click="runPreview">解析预览</el-button>

    <div v-if="preview" class="preview">
      <el-descriptions :column="2" border>
        <el-descriptions-item label="文件">{{ preview.filename }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ preview.status }}</el-descriptions-item>
        <el-descriptions-item label="产品">{{ previewData.products?.length || 0 }}</el-descriptions-item>
        <el-descriptions-item label="SKU">{{ previewData.skus?.length || 0 }}</el-descriptions-item>
        <el-descriptions-item label="价格规则">{{ previewData.priceRules?.length || 0 }}</el-descriptions-item>
        <el-descriptions-item label="运费规则">{{ previewData.freightRules?.length || 0 }}</el-descriptions-item>
      </el-descriptions>
      <el-alert v-for="warning in previewData.warnings || []" :key="warning" :title="warning" type="warning" :closable="false" />
    </div>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :disabled="!canCommit" :loading="committing" @click="commit">写入新草稿</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { commitCatalogImport, previewCatalogImport } from '@/api/catalog'

defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'committed'])
const file = ref(null)
const preview = ref(null)
const loading = ref(false)
const committing = ref(false)
const previewData = computed(() => preview.value?.previewJson || {})
const canCommit = computed(() => preview.value?.status === 'previewed' && previewData.value.accepted === true)

function handleChange(uploadFile) { file.value = uploadFile.raw; preview.value = null }
function handleRemove() { file.value = null; preview.value = null }
function close() { emit('update:modelValue', false) }

async function runPreview() {
  if (!file.value) return ElMessage.warning('请选择文件')
  loading.value = true
  try { const response = await previewCatalogImport(file.value); preview.value = response.data } finally { loading.value = false }
}

async function commit() {
  await ElMessageBox.confirm('确认将预览内容写入新的草稿版本？', '导入确认', { type: 'warning' })
  committing.value = true
  try { const response = await commitCatalogImport(preview.value.id); emit('committed', response.data) } finally { committing.value = false }
}
</script>

<style scoped>
.upload-box { margin: 16px 0; }
.preview { display: grid; gap: 10px; margin-top: 16px; }
</style>
