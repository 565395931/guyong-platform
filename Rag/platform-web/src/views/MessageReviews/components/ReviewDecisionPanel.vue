<template>
  <section class="decision-panel" aria-label="审核决定">
    <header class="decision-header">
      <div>
        <span class="decision-header__kicker">HUMAN DECISION</span>
        <h2>核查与处置</h2>
      </div>
      <el-tag v-if="item" :type="item.riskLevel === 'high' ? 'danger' : 'warning'" effect="dark">
        {{ item.riskLevel === 'high' ? '高风险' : '中风险' }}
      </el-tag>
    </header>

    <div v-if="item" v-loading="loading" class="decision-body">
      <section class="evidence-section">
        <h3>审核依据</h3>
        <dl class="evidence-grid">
          <div><dt>原因代码</dt><dd>{{ item.reasonCode || '-' }}</dd></div>
          <div><dt>模型</dt><dd>{{ item.modelName || '规则引擎 / 降级' }}</dd></div>
          <div><dt>置信度</dt><dd>{{ confidenceLabel }}</dd></div>
          <div><dt>AI 建议</dt><dd>{{ actionLabel(item.recommendedAction) }}</dd></div>
        </dl>
        <p class="evidence-reason">{{ item.reasonText || '模型未提供依据，需人工结合上下文判断。' }}</p>
        <div v-if="item.ruleHits?.length" class="rule-list">
          <el-tag v-for="rule in item.ruleHits" :key="rule" type="danger" effect="plain" size="small">{{ rule }}</el-tag>
        </div>
      </section>

      <template v-if="item.status === 'pending'">
        <div class="claim-state">
          <p>领取后才能提交人工回复或确认不回复。</p>
          <el-button type="primary" :loading="submitting" :icon="Select" @click="$emit('claim')">领取审核</el-button>
        </div>
      </template>

      <template v-else-if="item.status === 'claimed' && canResolve">
        <section class="action-section">
          <div class="section-title"><ChatLineRound /> <h3>回复并关闭</h3></div>
          <el-input v-model="replyText" type="textarea" :rows="5" maxlength="5000" show-word-limit placeholder="输入经人工核查后的回复内容" />
          <p v-if="replyError" class="field-error">{{ replyError }}</p>
          <el-button type="primary" :loading="submitting" :icon="Promotion" @click="submitReply">发送回复</el-button>
        </section>

        <section class="action-section action-section--dismiss">
          <div class="section-title"><CircleClose /> <h3>确认不回复</h3></div>
          <label class="field-label">不回复原因</label>
          <el-select v-model="dismissReason" placeholder="必须选择人工判断原因">
            <el-option label="垃圾或恶意消息" value="spam" />
            <el-option label="与业务无关" value="irrelevant" />
            <el-option label="重复消息" value="duplicate" />
            <el-option label="已通过其他渠道解决" value="already_resolved" />
            <el-option label="其他人工判断" value="other" />
          </el-select>
          <el-input v-model="dismissNote" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="补充备注（选填）" />
          <p v-if="dismissError" class="field-error">{{ dismissError }}</p>
          <el-button type="danger" plain :loading="submitting" :icon="CircleClose" @click="submitDismiss">确认不回复</el-button>
        </section>

        <el-button class="release-button" text :icon="Back" :disabled="submitting" @click="$emit('release')">释放回队列</el-button>
      </template>

      <div v-else-if="canTakeover" class="claim-state claim-state--takeover">
        <p>该任务正在由其他坐席处理。主管接管会立即转移处理权，并保留原领取记录。</p>
        <el-button type="warning" :loading="submitting" :icon="RefreshRight" @click="$emit('takeover')">接管审核任务</el-button>
      </div>

      <div v-else class="claim-state">
        <p>{{ item.status === 'claimed' ? '该任务正在由其他坐席处理。' : '该任务已处理完成。' }}</p>
      </div>
    </div>
    <el-empty v-else description="请选择审核任务" :image-size="72" />
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Back, ChatLineRound, CircleClose, Promotion, RefreshRight, Select } from '@element-plus/icons-vue'
import { validateDismiss, validateReply } from '@/modules/messageReviews/reviewQueue'

const props = defineProps({
  item: { type: Object, default: null },
  canResolve: { type: Boolean, default: false },
  canTakeover: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  submitting: { type: Boolean, default: false }
})
const emit = defineEmits(['claim', 'takeover', 'release', 'reply', 'dismiss'])
const replyText = ref('')
const dismissReason = ref('')
const dismissNote = ref('')
const replyError = ref('')
const dismissError = ref('')

watch(() => props.item?.id, () => {
  replyText.value = ''
  dismissReason.value = ''
  dismissNote.value = ''
  replyError.value = ''
  dismissError.value = ''
})

const confidenceLabel = computed(() => props.item?.confidence == null ? '不可用' : `${Math.round(props.item.confidence * 100)}%`)
const actionLabel = action => ({ allow: '可放行', review: '人工审核', no_reply: '建议不回复（须人工确认）' })[action] || '人工审核'

function submitReply() {
  replyError.value = validateReply(replyText.value)[0] || ''
  if (!replyError.value) emit('reply', replyText.value.trim())
}

function submitDismiss() {
  dismissError.value = validateDismiss({ reasonCode: dismissReason.value, note: dismissNote.value })[0] || ''
  if (!dismissError.value) emit('dismiss', { reasonCode: dismissReason.value, note: dismissNote.value.trim() })
}
</script>

<style scoped lang="scss">
.decision-panel { display: flex; min-width: 0; flex-direction: column; overflow: auto; border-left: 1px solid #dce2e8; background: #fff; }
.decision-header { display: flex; align-items: center; justify-content: space-between; min-height: 68px; padding: 12px 16px; border-bottom: 1px solid #dce2e8; }
.decision-header h2 { margin: 2px 0 0; color: #17202a; font-size: 16px; }
.decision-header__kicker { color: #77838f; font-family: Consolas, monospace; font-size: 10px; letter-spacing: 1px; }
.decision-body { display: flex; flex-direction: column; gap: 18px; padding: 16px; }
.evidence-section, .action-section { padding-bottom: 18px; border-bottom: 1px solid #e4e9ee; }
h3 { margin: 0 0 12px; color: #243440; font-size: 13px; }
.evidence-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0; }
.evidence-grid div { min-width: 0; }
.evidence-grid dt { color: #7a8791; font-size: 11px; }
.evidence-grid dd { overflow: hidden; margin: 3px 0 0; color: #263746; font-family: Consolas, monospace; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.evidence-reason { margin: 14px 0 0; padding: 10px; border-left: 3px solid #d69a2d; background: #fff9eb; color: #56616a; font-size: 12px; line-height: 1.6; }
.rule-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.claim-state { padding: 22px 14px; border: 1px dashed #bcc8d0; border-radius: 6px; background: #f7f9fa; text-align: center; }
.claim-state p { margin: 0 0 14px; color: #66737d; font-size: 12px; }
.claim-state--takeover { border-color: #e0b56b; background: #fffaf0; }
.action-section { display: flex; flex-direction: column; gap: 10px; }
.action-section--dismiss { padding: 14px; border: 1px solid #ead1d1; border-radius: 6px; background: #fffafa; }
.section-title { display: flex; align-items: center; gap: 7px; color: #52616c; }
.section-title svg { width: 15px; }
.section-title h3 { margin: 0; }
.field-label { color: #5f6c76; font-size: 12px; }
.field-error { margin: -3px 0 0; color: #c23d3d; font-size: 11px; }
.release-button { align-self: center; }
@media (max-width: 900px) { .decision-panel { min-height: 620px; border-left: 0; } }
</style>
