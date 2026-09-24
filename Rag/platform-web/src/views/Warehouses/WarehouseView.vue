<template>
  <div class="warehouse-view">
    <header class="page-heading">
      <div><span class="eyebrow">WAREHOUSE OPERATIONS</span><h1>仓库与库存</h1></div>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">刷新库存</el-button>
    </header>

    <section class="toolbar">
      <el-select v-model="selectedCode" placeholder="选择仓库" @change="loadWarehouseData">
        <el-option v-for="warehouse in warehouses" :key="warehouse.code" :label="`${warehouse.name} (${warehouse.code})`" :value="warehouse.code" />
      </el-select>
      <el-button v-if="canManage" :icon="Plus" @click="warehouseDialog = true">新建仓库</el-button>
      <el-button v-if="canManage && selectedCode" :icon="Download" @click="adjustDialog = true">收货 / 调整</el-button>
      <el-button v-if="canManage && selectedCode" :icon="Lock" @click="reservationDialog = true">预占库存</el-button>
    </section>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <section class="inventory-table" v-loading="loading">
      <el-table :data="inventory" stripe empty-text="当前仓库暂无库存记录">
        <el-table-column prop="skuCode" label="SKU" min-width="180" />
        <el-table-column prop="onHand" label="在库" width="130" />
        <el-table-column prop="reserved" label="已预占" width="130" />
        <el-table-column prop="available" label="可用库存" width="140"><template #default="{ row }"><el-tag :type="Number(row.available) > 0 ? 'success' : 'danger'">{{ row.available }}</el-tag></template></el-table-column>
      </el-table>
    </section>

    <section v-if="selectedCode" class="reservation-table" v-loading="reservationsLoading">
      <div class="section-heading">
        <h2>预占记录</h2>
        <el-select v-model="reservationStatus" clearable placeholder="全部状态" @change="loadReservations"><el-option label="已预占" value="reserved" /><el-option label="已取消" value="released" /><el-option label="已履约" value="fulfilled" /></el-select>
      </div>
      <el-table :data="reservations" stripe empty-text="当前无预占记录">
        <el-table-column prop="reservationKey" label="预占键" min-width="160" />
        <el-table-column prop="orderRef" label="订单号" min-width="140" />
        <el-table-column prop="status" label="状态" width="110" />
        <el-table-column label="SKU / 数量" min-width="180"><template #default="{ row }">{{ row.lines?.map(line => `${line.skuCode} x ${line.quantity}`).join('；') }}</template></el-table-column>
        <el-table-column v-if="canManage" label="操作" width="180"><template #default="{ row }"><el-button v-if="row.status === 'reserved'" size="small" @click="transitionReservation(row, 'release')">释放</el-button><el-button v-if="row.status === 'reserved'" size="small" type="primary" @click="transitionReservation(row, 'fulfill')">履约</el-button></template></el-table-column>
      </el-table>
    </section>

    <WarehouseLedgerPanel ref="ledgerPanel" :warehouse-code="selectedCode" @error="error = $event" />
    <PlatformSkuMappingPanel ref="mappingPanel" />

    <el-dialog v-model="warehouseDialog" title="新建仓库" width="420px">
      <el-form :model="warehouseForm" label-position="top"><el-form-item label="仓库编码"><el-input v-model="warehouseForm.code" maxlength="40" /></el-form-item><el-form-item label="仓库名称"><el-input v-model="warehouseForm.name" maxlength="120" /></el-form-item></el-form>
      <template #footer><el-button @click="warehouseDialog = false">取消</el-button><el-button type="primary" @click="submitWarehouse">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="adjustDialog" title="收货 / 库存调整" width="420px">
      <el-form :model="adjustForm" label-position="top"><el-form-item label="SKU"><el-input v-model="adjustForm.skuCode" /></el-form-item><el-form-item label="数量"><el-input v-model="adjustForm.quantity" placeholder="收货为正数，调整扣减为负数" /></el-form-item><el-form-item label="操作幂等键"><el-input v-model="adjustForm.idempotencyKey" /></el-form-item></el-form>
      <template #footer><el-button @click="adjustDialog = false">取消</el-button><el-button type="primary" @click="submitAdjustment">提交</el-button></template>
    </el-dialog>

    <el-dialog v-model="reservationDialog" title="预占库存" width="480px">
      <el-form :model="reservationForm" label-position="top"><el-form-item label="订单号"><el-input v-model="reservationForm.orderRef" /></el-form-item><el-form-item label="预占幂等键"><el-input v-model="reservationForm.reservationKey" /></el-form-item><el-form-item label="SKU"><el-input v-model="reservationForm.skuCode" /></el-form-item><el-form-item label="数量"><el-input v-model="reservationForm.quantity" /></el-form-item></el-form>
      <template #footer><el-button @click="reservationDialog = false">取消</el-button><el-button type="primary" @click="submitReservation">提交</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Download, Lock, Plus, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { adjustWarehouseInventory, createWarehouse, fulfillWarehouseReservation, getWarehouseInventory, getWarehouseReservations, getWarehouses, releaseWarehouseReservation, reserveWarehouseStock } from '@/api/warehouses'
import WarehouseLedgerPanel from './WarehouseLedgerPanel.vue'
import PlatformSkuMappingPanel from './PlatformSkuMappingPanel.vue'

const warehouses = ref([])
const inventory = ref([])
const reservations = ref([])
const selectedCode = ref('')
const loading = ref(false)
const reservationsLoading = ref(false)
const error = ref('')
const warehouseDialog = ref(false)
const adjustDialog = ref(false)
const reservationDialog = ref(false)
const reservationStatus = ref('reserved')
const ledgerPanel = ref(null)
const mappingPanel = ref(null)
const warehouseForm = reactive({ code: '', name: '' })
const adjustForm = reactive({ skuCode: '', quantity: '', idempotencyKey: '' })
const reservationForm = reactive({ orderRef: '', reservationKey: '', skuCode: '', quantity: '' })
const canManage = computed(() => { try { return ['admin', 'supervisor'].includes(JSON.parse(localStorage.getItem('platform_user') || '{}')?.role) } catch { return false } })

async function loadInventory() {
  if (!selectedCode.value) { inventory.value = []; return }
  const response = await getWarehouseInventory(selectedCode.value)
  inventory.value = Array.isArray(response.data) ? response.data : []
}

async function loadReservations() {
  if (!selectedCode.value) { reservations.value = []; return }
  reservationsLoading.value = true
  try { const response = await getWarehouseReservations(selectedCode.value, reservationStatus.value); reservations.value = Array.isArray(response.data) ? response.data : [] } catch (err) { error.value = err.message || '预占记录加载失败' } finally { reservationsLoading.value = false }
}

async function loadWarehouseData() { await Promise.all([loadInventory(), loadReservations(), ledgerPanel.value?.load?.(), mappingPanel.value?.load?.()]) }

async function load() {
  loading.value = true; error.value = ''
  try { const response = await getWarehouses(); warehouses.value = Array.isArray(response.data) ? response.data : []; if (!warehouses.value.some(item => item.code === selectedCode.value)) selectedCode.value = warehouses.value[0]?.code || ''; await loadWarehouseData() } catch (err) { error.value = err.message || '仓库数据加载失败' } finally { loading.value = false }
}

async function submitWarehouse() {
  try { await createWarehouse(warehouseForm); warehouseDialog.value = false; Object.assign(warehouseForm, { code: '', name: '' }); await load(); ElMessage.success('仓库已创建') } catch (err) { error.value = err.message || '仓库创建失败' }
}

async function submitAdjustment() {
  try { await adjustWarehouseInventory(selectedCode.value, adjustForm); adjustDialog.value = false; Object.assign(adjustForm, { skuCode: '', quantity: '', idempotencyKey: '' }); await Promise.all([loadInventory(), ledgerPanel.value?.load?.()]); ElMessage.success('库存已更新') } catch (err) { error.value = err.message || '库存更新失败' }
}

async function submitReservation() {
  try { await reserveWarehouseStock(selectedCode.value, { orderRef: reservationForm.orderRef, reservationKey: reservationForm.reservationKey, lines: [{ skuCode: reservationForm.skuCode, quantity: reservationForm.quantity }] }); reservationDialog.value = false; Object.assign(reservationForm, { orderRef: '', reservationKey: '', skuCode: '', quantity: '' }); await loadWarehouseData(); ElMessage.success('库存已预占') } catch (err) { error.value = err.message || '库存预占失败' }
}

async function transitionReservation(row, action) {
  try { if (action === 'release') await releaseWarehouseReservation(row.reservationKey); else await fulfillWarehouseReservation(row.reservationKey); await loadWarehouseData(); ElMessage.success(action === 'release' ? '预占已释放' : '预占已履约') } catch (err) { error.value = err.message || '预占状态更新失败' }
}

onMounted(load)
</script>

<style scoped>
.warehouse-view { display: flex; flex-direction: column; gap: 16px; min-height: 100%; padding: 20px; background: #f4f6f5; }
.page-heading, .toolbar, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.eyebrow { color: #21845e; font-size: 10px; font-weight: 700; }
h1 { margin: 4px 0 0; color: #17231d; font-size: 23px; }
.toolbar { padding: 12px 14px; border: 1px solid #dfe5e1; border-radius: 6px; background: #fff; }
.toolbar :deep(.el-select) { width: min(360px, 100%); }
.inventory-table, .reservation-table { border: 1px solid #dfe5e1; border-radius: 6px; background: #fff; overflow-x: auto; }
.inventory-table { min-height: 300px; }
.section-heading { padding: 14px; border-bottom: 1px solid #eef1ef; }
.section-heading h2 { margin: 0; color: #17231d; font-size: 16px; }
.section-heading :deep(.el-select) { width: 150px; }
.error-banner { padding: 10px 12px; border: 1px solid #efc9c4; border-radius: 6px; background: #fff5f4; color: #9b4037; }
@media (max-width: 680px) { .page-heading, .toolbar, .section-heading { align-items: stretch; flex-direction: column; } .toolbar :deep(.el-select), .section-heading :deep(.el-select) { width: 100%; } }
</style>
