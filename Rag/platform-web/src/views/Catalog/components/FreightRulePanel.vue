<template>
  <div class="catalog-panel">
    <div class="panel-header"><strong>运费规则</strong><el-button type="primary" :disabled="!editable" @click="open()">新增运费规则</el-button></div>
    <el-table v-loading="loading" :data="rows" border>
      <el-table-column prop="region_code" label="国家/区域" min-width="130" />
      <el-table-column prop="delivery_term" label="交付方式" width="100" />
      <el-table-column prop="base_weight_kg" label="首重(kg)" width="100" />
      <el-table-column label="基础运费" width="110"><template #default="{ row }">{{ row.manual_confirmation ? '人工确认' : row.base_fee ?? '-' }}</template></el-table-column>
      <el-table-column label="续重" min-width="160"><template #default="{ row }">{{ incrementalText(row) }}</template></el-table-column>
      <el-table-column prop="currency" label="币种" width="90" />
      <el-table-column label="人工确认" width="100"><template #default="{ row }"><el-tag :type="row.manual_confirmation ? 'warning' : 'success'">{{ row.manual_confirmation ? '需要' : '不需要' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" :disabled="!editable" @click="open(row)">编辑</el-button></template></el-table-column>
    </el-table>

    <el-dialog v-model="visible" title="运费规则" width="620px">
      <el-form label-width="120px">
        <el-form-item label="国家/区域编码"><el-input v-model="form.regionCode" placeholder="如 US、IN、DEFAULT" /></el-form-item>
        <el-form-item label="交付方式"><el-select v-model="form.deliveryTerm"><el-option label="普通/其他" value="OTHER"/><el-option label="DDU" value="DDU"/><el-option label="DDP" value="DDP"/></el-select></el-form-item>
        <el-form-item label="首重(kg)"><el-input-number v-model="form.baseWeightKg" :min="0.001" :precision="3" /></el-form-item>
        <el-form-item label="基础运费"><el-input-number v-model="form.baseFee" :min="0.01" :precision="2" :disabled="form.manualConfirmation" /></el-form-item>
        <el-form-item label="每次续重(kg)"><el-input-number v-model="form.incrementalWeightKg" :min="0.001" :precision="3" :disabled="form.manualConfirmation" /></el-form-item>
        <el-form-item label="续重费用"><el-input-number v-model="form.incrementalFee" :min="0.01" :precision="2" :disabled="form.manualConfirmation" /></el-form-item>
        <el-form-item label="币种"><el-input v-model="form.currency" /></el-form-item>
        <el-form-item label="需要人工确认"><el-switch v-model="form.manualConfirmation" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="visible = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getFreightRules, saveFreightRule } from '@/api/catalog'
import { normalizeFreightForm, validateFreightForm } from '@/modules/catalog/catalogForm'

const props = defineProps({ version: { type: Object, required: true } })
const editable = computed(() => props.version.status === 'draft')
const rows = ref([])
const loading = ref(false)
const visible = ref(false)
const form = reactive({ id: undefined, regionCode: '', deliveryTerm: 'OTHER', baseWeightKg: 0.5, baseFee: null, incrementalWeightKg: 0.5, incrementalFee: null, currency: 'USD', manualConfirmation: false })
const incrementalText = row => {
  if (row.manual_confirmation) return '人工确认'
  if (row.incremental_weight_kg == null || row.incremental_fee == null) return '-'
  return `${row.incremental_weight_kg} kg / ${row.incremental_fee}`
}

async function load() { loading.value = true; try { const response = await getFreightRules(props.version.id); rows.value = response.data || [] } finally { loading.value = false } }
function open(row = null) { Object.assign(form, normalizeFreightForm(row || { regionCode: '', deliveryTerm: 'OTHER', baseWeightKg: 0.5, currency: 'USD' })); visible.value = true }
async function save() {
  const payload = normalizeFreightForm(form)
  const errors = validateFreightForm(payload)
  if (errors.length) return ElMessage.error(errors[0])
  await saveFreightRule(props.version.id, payload)
  visible.value = false
  ElMessage.success('运费规则已保存')
  await load()
}
onMounted(load)
</script>

<style scoped>
.catalog-panel { display: grid; gap: 12px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; }
</style>
