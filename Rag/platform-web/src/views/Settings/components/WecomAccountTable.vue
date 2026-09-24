<template>
  <section class="account-section">
    <div class="section-heading">
      <div>
        <h2>微信客服账号</h2>
        <p v-if="connection">{{ connection.connectionName }} · 官方同步账号</p>
        <p v-else>请先选择上方企业连接</p>
      </div>
      <div class="heading-status">
        <el-tag v-if="connection?.status === 'active'" type="warning" effect="plain">网关运行中，配置只读</el-tag>
        <el-tag v-if="connection" effect="plain">{{ rows.length }} 个账号</el-tag>
      </div>
    </div>

    <el-table v-loading="loading" :data="rows" row-key="id" empty-text="该企业尚未同步客服账号">
      <el-table-column label="客服账号" min-width="190">
        <template #default="{ row }">
          <div class="account-name"><strong>{{ row.accountName }}</strong><small>{{ row.externalAccountId }}</small></div>
        </template>
      </el-table-column>
      <el-table-column label="保护级别" width="150">
        <template #default="{ row }">
          <el-tag v-if="isBaseline(row)" type="danger" effect="plain"><el-icon><Lock /></el-icon> 生产保护</el-tag>
          <el-select v-else :model-value="row.protectionLevel" size="small" :disabled="policyLocked(row)" @change="value => changePolicy(row, { protectionLevel: value, aiEnabled: false })">
            <el-option label="锁定" value="locked" />
            <el-option label="测试模式" value="test" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="白名单" width="105" align="center">
        <template #default="{ row }">
          <el-switch :model-value="row.allowlistEnabled" :disabled="policyLocked(row)" @change="value => changePolicy(row, { allowlistEnabled: value })" />
        </template>
      </el-table-column>
      <el-table-column label="AI 自动回复" width="125" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.aiEnabled"
            :disabled="policyLocked(row) || row.protectionLevel !== 'test' || !row.allowlistEnabled"
            @change="value => changePolicy(row, { aiEnabled: value })"
          />
        </template>
      </el-table-column>
      <el-table-column label="同步状态" width="110">
        <template #default="{ row }"><el-tag :type="row.syncStatus === 'synced' ? 'success' : 'warning'" effect="plain">{{ row.syncStatus === 'synced' ? '已同步' : '需检查' }}</el-tag></template>
      </el-table-column>
      <el-table-column label="最近收发" min-width="170">
        <template #default="{ row }">{{ latestActivity(row) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            :icon="UserFilled"
            :disabled="!canOpenAllowlist(row)"
            @click="$emit('manage-allowlist', row)"
          >白名单</el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<script setup>
import { ElMessage } from 'element-plus'
import { Lock, UserFilled } from '@element-plus/icons-vue'
import {
  canEditAccountConfiguration,
  canOpenAllowlist,
  normalizePolicyForm,
  validatePolicyForm
} from '@/modules/platformConnections/connectionForm'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  connection: { type: Object, default: null },
  loading: { type: Boolean, default: false }
})
const emit = defineEmits(['update-policy', 'manage-allowlist'])
const isBaseline = row => row.lockedReason === 'production_baseline'
const policyLocked = row => isBaseline(row) || !canEditAccountConfiguration(props.connection)
function changePolicy(row, changes) {
  const policy = normalizePolicyForm({
    protectionLevel: row.protectionLevel,
    aiEnabled: row.aiEnabled,
    allowlistEnabled: row.allowlistEnabled,
    ...changes
  })
  const errors = validatePolicyForm(policy)
  if (errors.length) return ElMessage.warning(errors[0])
  emit('update-policy', row.id, policy)
}
function latestActivity(row) {
  const values = [row.lastInboundAt, row.lastOutboundAt].filter(Boolean).map(value => new Date(value).getTime())
  return values.length ? new Date(Math.max(...values)).toLocaleString('zh-CN', { hour12: false }) : '-'
}
</script>

<style scoped>
.account-section { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; box-sizing: border-box; background: #fff; border: 1px solid #dde4e1; border-radius: 8px; padding: 18px; }
.section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 16px; }
.section-heading h2 { margin: 0 0 4px; font-size: 17px; color: #15231d; }
.section-heading p { margin: 0; color: #68756f; font-size: 13px; }
.heading-status { display: flex; gap: 8px; align-items: center; }
.account-name strong, .account-name small { display: block; }
.account-name small { margin-top: 2px; color: #809088; font-family: Consolas, monospace; }
</style>
