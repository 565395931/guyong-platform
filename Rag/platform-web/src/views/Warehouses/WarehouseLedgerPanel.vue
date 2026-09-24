<template>
  <section class="ledger-panel" v-loading="loading">
    <div class="ledger-panel__header">
      <h2>库存流水</h2>
      <div class="ledger-panel__filters">
        <el-input v-model.trim="filters.skuCode" clearable placeholder="筛选 SKU" @keyup.enter="search" />
        <el-select v-model="filters.operationType" clearable placeholder="全部操作" @change="search">
          <el-option label="收货入库" value="receipt" />
          <el-option label="库存调整" value="adjustment" />
          <el-option label="库存预占" value="reserve" />
          <el-option label="释放预占" value="release" />
          <el-option label="履约扣减" value="fulfill" />
        </el-select>
        <el-button :icon="Search" @click="search">查询</el-button>
      </div>
    </div>

    <el-table :data="items" stripe empty-text="暂无库存流水">
      <el-table-column prop="createdAt" label="发生时间" min-width="170"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column prop="skuCode" label="SKU" min-width="150" />
      <el-table-column prop="operationType" label="操作类型" width="110"><template #default="{ row }"><el-tag effect="plain" :type="operationTag(row.operationType)">{{ operationLabel(row.operationType) }}</el-tag></template></el-table-column>
      <el-table-column prop="onHandDelta" label="在库变动" width="110"><template #default="{ row }"><span :class="deltaClass(row.onHandDelta)">{{ signed(row.onHandDelta) }}</span></template></el-table-column>
      <el-table-column prop="reservedDelta" label="预占变动" width="110"><template #default="{ row }"><span :class="deltaClass(row.reservedDelta)">{{ signed(row.reservedDelta) }}</span></template></el-table-column>
      <el-table-column prop="referenceKey" label="业务引用" min-width="150"><template #default="{ row }">{{ row.referenceKey || '-' }}</template></el-table-column>
      <el-table-column prop="createdBy" label="操作人" width="100"><template #default="{ row }">{{ row.createdBy || '-' }}</template></el-table-column>
    </el-table>

    <el-pagination
      v-if="total > 0"
      v-model:current-page="filters.page"
      v-model:page-size="filters.pageSize"
      class="ledger-panel__pagination"
      layout="total, sizes, prev, pager, next"
      :page-sizes="[20, 50, 100]"
      :total="total"
      @current-change="load"
      @size-change="changePageSize"
    />
  </section>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { getWarehouseLedger } from '@/api/warehouses'

const props = defineProps({ warehouseCode: { type: String, default: '' } })
const emit = defineEmits(['error'])
const items = ref([])
const total = ref(0)
const loading = ref(false)
const filters = reactive({ skuCode: '', operationType: '', page: 1, pageSize: 20 })

const labels = { receipt: '收货', adjustment: '调整', reserve: '预占', release: '释放', fulfill: '履约' }
const operationLabel = type => labels[type] || type
const operationTag = type => ({ receipt: 'success', adjustment: 'warning', reserve: 'info', release: '', fulfill: 'success' })[type] || 'info'
const deltaClass = value => Number(value) > 0 ? 'delta-positive' : Number(value) < 0 ? 'delta-negative' : ''
const signed = value => Number(value) > 0 ? `+${value}` : String(value ?? '0')
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'

async function load() {
  if (!props.warehouseCode) { items.value = []; total.value = 0; return }
  loading.value = true
  try {
    const response = await getWarehouseLedger(props.warehouseCode, filters)
    items.value = Array.isArray(response.data?.items) ? response.data.items : []
    total.value = Number(response.data?.total || 0)
  } catch (error) { emit('error', error.message || '库存流水加载失败') } finally { loading.value = false }
}

function search() { filters.page = 1; load() }
function changePageSize() { filters.page = 1; load() }
watch(() => props.warehouseCode, () => { filters.page = 1; load() }, { immediate: true })
defineExpose({ load })
</script>

<style scoped>
.ledger-panel { border: 1px solid #dfe5e1; border-radius: 6px; background: #fff; overflow-x: auto; }
.ledger-panel__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px; border-bottom: 1px solid #eef1ef; }
.ledger-panel__header h2 { margin: 0; color: #17231d; font-size: 16px; }
.ledger-panel__filters { display: flex; align-items: center; gap: 8px; }
.ledger-panel__filters :deep(.el-input) { width: 180px; }
.ledger-panel__filters :deep(.el-select) { width: 150px; }
.ledger-panel__pagination { justify-content: flex-end; padding: 14px; }
.delta-positive { color: #167653; font-weight: 600; }
.delta-negative { color: #b3473d; font-weight: 600; }
@media (max-width: 720px) { .ledger-panel__header, .ledger-panel__filters { align-items: stretch; flex-direction: column; } .ledger-panel__filters :deep(.el-input), .ledger-panel__filters :deep(.el-select) { width: 100%; } }
</style>
