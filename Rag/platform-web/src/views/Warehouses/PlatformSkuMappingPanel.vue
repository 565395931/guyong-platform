<template>
  <section class="mapping-panel">
    <div class="section-heading">
      <div><h2>平台 SKU 映射</h2><span class="muted">将平台商品编码绑定到仓库内部 SKU</span></div>
      <el-button v-if="canManage" type="primary" @click="dialogVisible = true">新增映射</el-button>
    </div>
    <div class="mapping-filters">
      <el-input v-model="filters.channel" clearable placeholder="渠道，如 taobao" @keyup.enter="load" />
      <el-input v-model="filters.accountId" clearable placeholder="店铺账号 ID" @keyup.enter="load" />
      <el-button @click="load">查询</el-button>
    </div>
    <el-table v-loading="loading" :data="items" stripe empty-text="暂无 SKU 映射">
      <el-table-column prop="channel" label="渠道" width="120" />
      <el-table-column prop="accountId" label="账号" width="90" />
      <el-table-column prop="externalSku" label="平台 SKU" min-width="180" />
      <el-table-column prop="internalSkuCode" label="仓库 SKU" min-width="180" />
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column v-if="canManage" label="操作" width="100"><template #default="{ row }"><el-button link @click="toggleStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" title="新增平台 SKU 映射" width="440px">
      <el-form :model="form" label-position="top">
        <el-form-item label="渠道"><el-input v-model="form.channel" placeholder="taobao / pinduoduo" /></el-form-item>
        <el-form-item label="店铺账号 ID"><el-input v-model="form.accountId" /></el-form-item>
        <el-form-item label="平台 SKU"><el-input v-model="form.externalSku" /></el-form-item>
        <el-form-item label="仓库内部 SKU"><el-input v-model="form.internalSkuCode" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="submit">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getPlatformSkuMappings, savePlatformSkuMapping, setPlatformSkuMappingStatus } from '@/api/platformSkuMappings'

const items = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const filters = reactive({ channel: '', accountId: '' })
const form = reactive({ channel: '', accountId: '', externalSku: '', internalSkuCode: '' })
const canManage = computed(() => { try { return ['admin', 'supervisor'].includes(JSON.parse(localStorage.getItem('platform_user') || '{}')?.role) } catch { return false } })

async function load() {
  loading.value = true
  try { const response = await getPlatformSkuMappings(filters); items.value = Array.isArray(response.data) ? response.data : [] } catch (error) { ElMessage.error(error.message || 'SKU 映射加载失败') } finally { loading.value = false }
}

async function submit() {
  try { await savePlatformSkuMapping(form); dialogVisible.value = false; Object.assign(form, { channel: '', accountId: '', externalSku: '', internalSkuCode: '' }); await load(); ElMessage.success('SKU 映射已保存') } catch (error) { ElMessage.error(error.message || 'SKU 映射保存失败') }
}

async function toggleStatus(row) {
  try { await setPlatformSkuMappingStatus(row.id, row.status === 'active' ? 'inactive' : 'active'); await load() } catch (error) { ElMessage.error(error.message || 'SKU 映射状态更新失败') }
}

defineExpose({ load })
onMounted(load)
</script>

<style scoped>
.mapping-panel { border: 1px solid #dfe5e1; border-radius: 6px; background: #fff; overflow: hidden; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px; border-bottom: 1px solid #eef1ef; }
.section-heading h2 { margin: 0; color: #17231d; font-size: 16px; }
.muted { color: #6d7c73; font-size: 12px; }
.mapping-filters { display: flex; gap: 8px; padding: 12px 14px; }
.mapping-filters .el-input { max-width: 220px; }
@media (max-width: 680px) { .section-heading, .mapping-filters { align-items: stretch; flex-direction: column; } .mapping-filters .el-input { max-width: none; } }
</style>
