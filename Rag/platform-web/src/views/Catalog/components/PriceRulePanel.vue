<template>
  <div class="catalog-panel">
    <div class="panel-header"><strong>阶梯价格</strong><el-button type="primary" :disabled="!editable" @click="open()">新增价格规则</el-button></div>
    <el-table v-loading="loading" :data="rows" border>
      <el-table-column prop="sku_code" label="SKU" min-width="150" />
      <el-table-column label="客户类型" width="110"><template #default="{ row }">{{ customerTypeText(row.customer_type) }}</template></el-table-column>
      <el-table-column label="数量区间" width="150"><template #default="{ row }">{{ quantityRangeText(row) }}</template></el-table-column>
      <el-table-column prop="unit" label="单位" width="90" />
      <el-table-column prop="unit_price" label="单价" width="110" />
      <el-table-column prop="currency" label="币种" width="90" />
      <el-table-column label="有效期" min-width="210"><template #default="{ row }">{{ row.effective_from || '立即' }} 至 {{ row.effective_to || '长期' }}</template></el-table-column>
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ statusText(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" :disabled="!editable" @click="open(row)">编辑</el-button></template></el-table-column>
    </el-table>

    <el-dialog v-model="visible" title="价格规则" width="620px">
      <el-form label-width="110px">
        <el-form-item label="SKU"><el-select v-model="form.skuCode" filterable><el-option v-for="item in skus" :key="item.sku_code" :label="`${item.sku_code} ${item.specification || ''}`" :value="item.sku_code" /></el-select></el-form-item>
        <el-form-item label="客户类型"><el-select v-model="form.customerType"><el-option label="全部" value="all"/><el-option label="零售" value="retail"/><el-option label="批发" value="wholesale"/></el-select></el-form-item>
        <el-form-item label="数量区间"><el-input-number v-model="form.minQuantity" :min="0.001" :precision="3" /> 至 <el-input-number v-model="form.maxQuantity" :min="0.001" :precision="3" placeholder="不限" /></el-form-item>
        <el-form-item label="单位"><el-select v-model="form.unit"><el-option label="kg" value="kg"/><el-option label="ml" value="ml"/><el-option label="件" value="piece"/><el-option label="㎡" value="sqm"/></el-select></el-form-item>
        <el-form-item label="单价"><el-input-number v-model="form.unitPrice" :min="0.01" :precision="2" /></el-form-item>
        <el-form-item label="币种"><el-input v-model="form.currency" /></el-form-item>
        <el-form-item label="生效时间"><el-date-picker v-model="form.effectiveFrom" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" clearable /></el-form-item>
        <el-form-item label="失效时间"><el-date-picker v-model="form.effectiveTo" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" clearable /></el-form-item>
        <el-form-item label="状态"><el-select v-model="form.status"><el-option label="启用" value="active"/><el-option label="停用" value="inactive"/></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="visible = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getPriceRules, getSkus, savePriceRule } from '@/api/catalog'
import { normalizePriceForm, validatePriceForm } from '@/modules/catalog/catalogForm'

const props = defineProps({ version: { type: Object, required: true } })
const editable = computed(() => props.version.status === 'draft')
const rows = ref([])
const skus = ref([])
const loading = ref(false)
const visible = ref(false)
const form = reactive({ id: undefined, skuCode: '', customerType: 'retail', minQuantity: 1, maxQuantity: null, unit: 'kg', currency: 'USD', unitPrice: 0, effectiveFrom: null, effectiveTo: null, status: 'active' })
const customerTypeText = value => ({ all: '全部', retail: '零售', wholesale: '批发' }[value] || value)
const statusText = status => ({ active: '启用', inactive: '停用' }[status] || status)
const quantityRangeText = row => row.max_quantity == null
  ? `${row.min_quantity} 以上`
  : `${row.min_quantity} - ${row.max_quantity}`

async function load() {
  loading.value = true
  try {
    const [priceResponse, skuResponse] = await Promise.all([getPriceRules(props.version.id), getSkus(props.version.id)])
    rows.value = priceResponse.data || []
    skus.value = skuResponse.data || []
  } finally { loading.value = false }
}

function open(row = null) {
  Object.assign(form, normalizePriceForm(row || { skuCode: skus.value[0]?.sku_code || '', customerType: 'retail', minQuantity: 1, unit: 'kg', currency: 'USD', unitPrice: 0 }))
  visible.value = true
}

async function save() {
  const payload = normalizePriceForm(form)
  const errors = validatePriceForm(payload)
  if (errors.length) return ElMessage.error(errors[0])
  await savePriceRule(props.version.id, payload)
  visible.value = false
  ElMessage.success('价格规则已保存')
  await load()
}

onMounted(load)
</script>

<style scoped>
.catalog-panel { display: grid; gap: 12px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; }
</style>
