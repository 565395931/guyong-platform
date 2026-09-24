<template>
  <el-drawer
    :model-value="modelValue"
    title="客户工作区"
    direction="rtl"
    size="480px"
    :append-to-body="true"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div v-loading="loading" class="customer-workspace-drawer">
      <el-alert v-if="error" type="error" :closable="false" :title="error" />
      <template v-if="workspace.customer">
        <header class="workspace-header">
          <div class="workspace-avatar">{{ avatarText }}</div>
          <div class="workspace-header__identity">
            <strong>{{ customerName }}</strong>
            <span>{{ workspace.customer.phone || workspace.customer.email || '未提供联系方式' }}</span>
          </div>
          <el-tag v-if="workspace.stage.label" size="small" type="info">{{ workspace.stage.label }}</el-tag>
          <el-tag size="small" effect="plain">{{ workspace.language.label || workspace.language.code }}</el-tag>
        </header>

        <el-tabs v-model="activeTab" stretch>
          <el-tab-pane label="智能概览" name="overview">
            <section class="workspace-section">
              <h3>客户画像</h3>
              <p>{{ workspace.profile.summary || '暂无 AI 摘要' }}</p>
              <p class="muted">语言置信度 {{ Math.round(Number(workspace.language.confidence || 0) * 100) }}% · 语气 {{ workspace.language.politeness === 'honorific' ? '礼貌敬语' : '自然礼貌' }}</p>
              <div v-if="signals.length" class="signal-list">
                <el-tag v-for="signal in signals" :key="signal.code || signal.label" size="small" effect="plain">
                  {{ signal.label || signal.code }}
                </el-tag>
              </div>
            </section>
            <section v-if="workspace.activeConversation" class="workspace-section">
              <h3>当前会话</h3>
              <p class="muted">{{ workspace.activeConversation.channel || '未知渠道' }} · {{ workspace.activeConversation.id }}</p>
              <p>{{ workspace.activeConversation.last_message || '暂无最近消息' }}</p>
            </section>
          </el-tab-pane>

          <el-tab-pane label="沟通时间线" name="timeline">
            <el-timeline v-if="timeline.length">
              <el-timeline-item v-for="item in timeline" :key="item.id || item.communication_date" :timestamp="item.communication_date || item.createdAt">
                {{ item.summary || item.label || `${item.message_count || 0} 条消息` }}
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无沟通记录" :image-size="60" />
          </el-tab-pane>

          <el-tab-pane label="跟进任务" name="followups">
            <el-empty v-if="!workspace.followups.length" description="暂无跟进任务" :image-size="60" />
            <div v-else class="item-list">
              <div v-for="item in workspace.followups" :key="item.id" class="list-item">
                <div>
                  <strong>{{ item.type || '客户跟进' }}</strong>
                  <span class="muted">{{ item.dueAt || item.due_at || '待 AI 判断' }}</span>
                </div>
                <el-tag size="small" :type="item.status === 'completed' ? 'success' : 'warning'">{{ item.status || 'pending' }}</el-tag>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="订单" name="orders">
            <el-empty v-if="!workspace.orders.length" description="暂无订单" :image-size="60" />
            <div v-else class="item-list">
              <div v-for="order in workspace.orders" :key="order.id || order.order_no" class="list-item">
                <div><strong>{{ order.order_no || order.id }}</strong><span class="muted">{{ order.status || '未知状态' }}</span></div>
                <span>{{ order.deal_amount ?? order.amount ?? '-' }}</span>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>

        <footer class="workspace-actions">
          <el-button v-if="workspace.permissions.markWon" type="success" plain @click="$emit('mark-won', workspace.customer)">标记成交</el-button>
          <el-button v-if="workspace.permissions.manageFollowups" type="primary" plain @click="$emit('manage-followups', workspace.customer)">管理跟进</el-button>
          <el-button plain @click="$emit('open-profile', workspace.customer)">打开完整画像</el-button>
        </footer>
      </template>
      <el-empty v-else-if="!loading && !error" description="未找到客户上下文" :image-size="70" />
    </div>
  </el-drawer>
</template>

<script setup>
import { computed, ref } from 'vue'
import { normalizeCustomerWorkspace, workspaceCustomerName } from '@/modules/customers/customerWorkspace'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  context: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' }
})
defineEmits(['update:modelValue', 'mark-won', 'manage-followups', 'open-profile'])
const activeTab = ref('overview')
const workspace = computed(() => normalizeCustomerWorkspace(props.context))
const customerName = computed(() => workspaceCustomerName(workspace.value.customer))
const avatarText = computed(() => customerName.value.slice(-2) || '?')
const signals = computed(() => Array.isArray(workspace.value.profile.signals) ? workspace.value.profile.signals : [])
const timeline = computed(() => workspace.value.customer?.communicationDays || workspace.value.customer?.communication_days || [])
</script>

<style scoped>
.customer-workspace-drawer { min-height: 100%; color: #334155; }
.workspace-header { display: flex; align-items: center; gap: 10px; padding-bottom: 14px; border-bottom: 1px solid #e2e8f0; }
.workspace-avatar { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: #0ea5e9; color: #fff; font-weight: 700; }
.workspace-header__identity { display: grid; flex: 1; gap: 3px; min-width: 0; }
.workspace-header__identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-header__identity span, .muted { color: #64748b; font-size: 12px; }
.workspace-section { padding: 14px 0; border-bottom: 1px solid #f1f5f9; }
.workspace-section h3 { margin: 0 0 8px; font-size: 13px; }
.workspace-section p { margin: 0; color: #475569; font-size: 12px; line-height: 1.7; }
.signal-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.item-list { display: grid; gap: 8px; }
.list-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 10px; border: 1px solid #e2e8f0; border-radius: 6px; }
.list-item > div { display: grid; gap: 3px; min-width: 0; }
.list-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.workspace-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 16px; }
@media (max-width: 620px) { :global(.el-drawer.rtl) { width: 100% !important; } }
</style>
