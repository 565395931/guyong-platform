<template>
  <div class="ai-config-view">
    <header class="page-heading">
      <div>
        <span class="page-kicker">AI OPERATIONS</span>
        <h1>AI 配置</h1>
        <p>审核阈值、模型与运行参数</p>
      </div>
      <div class="page-actions">
        <el-tooltip content="重新载入配置" placement="bottom">
          <el-button circle :icon="Refresh" :loading="loading" aria-label="重新载入配置" @click="loadConfig" />
        </el-tooltip>
        <el-button type="primary" :icon="Check" :loading="saving" @click="saveChanges">保存更改</el-button>
      </div>
    </header>

    <main v-loading="loading" class="config-content">
      <section class="provider-band">
        <div class="band-intro">
          <span>00</span>
          <div>
            <h2>第三方模型服务</h2>
            <p>管理服务凭据、可用模型与账户能力。</p>
          </div>
        </div>
        <div class="provider-panel">
          <div class="provider-heading">
            <div>
              <strong>{{ provider.provider?.label || '阿里云百炼 DashScope' }}</strong>
              <span :class="['provider-status', providerTested ? 'is-online' : '']">{{ providerTested ? '连接正常' : '等待连接测试' }}</span>
            </div>
            <code>{{ provider.provider?.baseURL }}</code>
          </div>
          <div class="provider-grid">
            <label class="provider-field">
              <span>API Key</span>
              <el-input v-model="credentialInput" type="password" show-password placeholder="输入新密钥以替换当前配置" />
              <small v-if="provider.credential?.configured">
                已配置 ········ {{ provider.credential.lastFour }}（{{ provider.credential.source === 'environment' ? '环境变量' : '后台配置' }}）
              </small>
            </label>
            <div class="provider-actions">
              <el-button :loading="providerTesting" @click="handleTestProvider">测试连接</el-button>
              <el-button type="primary" :disabled="!credentialInput.trim()" :loading="credentialSaving" @click="handleSaveCredential">修改密钥</el-button>
              <el-button :disabled="provider.credential?.source !== 'database'" @click="handleClearCredential">清除覆盖</el-button>
            </div>
          </div>
          <div class="provider-metrics">
            <div>
              <span>可用模型</span><strong>{{ provider.models?.length || 0 }}</strong>
              <small>{{ provider.modelsSyncedAt ? `同步于 ${formatTime(provider.modelsSyncedAt)}` : '尚未同步' }}</small>
              <el-button text :loading="modelsSyncing" @click="handleSyncModels">同步模型列表</el-button>
            </div>
            <div>
              <span>账户余额</span><strong>{{ balanceText }}</strong>
              <small>{{ balanceReason }}</small>
              <el-button text :loading="balanceLoading" @click="handleBalance">刷新余额</el-button>
            </div>
          </div>
        </div>
      </section>
      <section v-for="group in groups" :key="group.key" class="config-band">
        <div class="band-intro">
          <span>{{ group.index }}</span>
          <div>
            <h2>{{ group.label }}</h2>
            <p>{{ group.description }}</p>
          </div>
        </div>
        <div class="field-grid">
          <label v-for="field in fieldsByGroup(group.key)" :key="field.key" class="config-field">
            <span class="config-field__label">{{ field.label }}</span>
            <el-switch v-if="field.type === 'boolean'" v-model="form[field.key]" />
            <el-input-number
              v-else-if="field.type === 'number'"
              v-model="form[field.key]"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              controls-position="right"
            />
            <el-select
              v-else-if="field.type === 'model'"
              v-model="form[field.key]"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入模型 ID"
            >
              <el-option v-for="model in provider.models" :key="model" :label="model" :value="model" />
            </el-select>
            <el-input v-else v-model="form[field.key]" />
            <small v-if="errors[field.key]" class="field-error">{{ errors[field.key] }}</small>
            <code>{{ field.key }}</code>
          </label>
        </div>
      </section>

      <section class="safety-band" aria-label="不可修改的安全边界">
        <div class="band-intro">
          <span>04</span>
          <div>
            <h2>不可修改的安全边界</h2>
            <p>这些规则固化在服务端，不提供开关。</p>
          </div>
        </div>
        <ul>
          <li>审核发生在会话路由和 AI 回复入队之前。</li>
          <li>硬规则命中不能被模型的放行建议覆盖。</li>
          <li>模型失败时进入人工审核。</li>
          <li>任何不回复决定必须由人工确认。</li>
          <li>人工回复只有在渠道发送成功后才关闭审核任务。</li>
        </ul>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { Check, Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  clearAiProviderCredential, getAiConfig, getAiProvider, getAiProviderBalance,
  saveAiProviderCredential, syncAiProviderModels, testAiProvider, updateAiConfig
} from '@/api/aiConfig'
import {
  AI_CONFIG_FIELDS,
  normalizeAiConfig,
  normalizeFieldValue,
  validateAiConfig
} from '@/modules/aiConfig/aiConfigForm'

const groups = [
  { key: 'review', index: '01', label: '消息审核', description: '控制入站风险判定、上下文和降级阈值。' },
  { key: 'reply', index: '02', label: '回复模型', description: '配置自动回复、坐席建议、校验和翻译模型。' },
  { key: 'runtime', index: '03', label: '运行参数', description: '限制调用时长、并发和各类上下文规模。' }
]
const form = reactive({})
const original = reactive({})
const errors = reactive({})
const loading = ref(false)
const saving = ref(false)
const provider = reactive({ models: [] })
const credentialInput = ref('')
const credentialSaving = ref(false)
const providerTesting = ref(false)
const providerTested = ref(false)
const modelsSyncing = ref(false)
const balanceLoading = ref(false)
const balance = reactive({ supported: null, amount: null, currency: null, reason: '' })
const balanceText = computed(() => balance.supported ? `${balance.currency || ''} ${balance.amount}`.trim() : '不可查询')
const balanceReason = computed(() => balance.reason || (balance.supported === null ? '尚未查询' : '供应商未提供余额接口'))
const fieldsByGroup = key => AI_CONFIG_FIELDS.filter(field => field.group === key)

async function loadConfig() {
  loading.value = true
  try {
    const response = await getAiConfig()
    const values = normalizeAiConfig(response.data || {})
    for (const field of AI_CONFIG_FIELDS) {
      form[field.key] = values[field.key]
      original[field.key] = values[field.key]
    }
    Object.keys(errors).forEach(key => delete errors[key])
  } finally {
    loading.value = false
  }
}

async function loadProvider() {
  const response = await getAiProvider()
  Object.assign(provider, response.data?.data || response.data || {})
}

const formatTime = value => new Date(value).toLocaleString()

async function handleSaveCredential() {
  credentialSaving.value = true
  try {
    await saveAiProviderCredential(credentialInput.value.trim())
    credentialInput.value = ''
    providerTested.value = false
    await loadProvider()
    ElMessage.success('API Key 已安全保存')
  } finally { credentialSaving.value = false }
}

async function handleClearCredential() {
  await ElMessageBox.confirm('清除后台密钥覆盖后，将回退到服务器环境变量。', '清除 API Key 覆盖', { type: 'warning' })
  await clearAiProviderCredential()
  providerTested.value = false
  await loadProvider()
  ElMessage.success('后台密钥覆盖已清除')
}

async function handleTestProvider() {
  providerTesting.value = true
  try {
    const response = await testAiProvider(credentialInput.value.trim())
    providerTested.value = true
    ElMessage.success(`连接正常，可访问 ${response.data?.data?.modelCount ?? 0} 个模型`)
  } finally { providerTesting.value = false }
}

async function handleSyncModels() {
  modelsSyncing.value = true
  try {
    const response = await syncAiProviderModels()
    provider.models = response.data?.data?.models || []
    provider.modelsSyncedAt = response.data?.data?.syncedAt
    ElMessage.success(`已同步 ${provider.models.length} 个模型`)
  } finally { modelsSyncing.value = false }
}

async function handleBalance() {
  balanceLoading.value = true
  try { Object.assign(balance, (await getAiProviderBalance()).data?.data || {}) }
  finally { balanceLoading.value = false }
}

async function saveChanges() {
  const validation = validateAiConfig(form)
  Object.keys(errors).forEach(key => delete errors[key])
  Object.assign(errors, validation)
  if (Object.keys(validation).length) {
    ElMessage.warning('请先修正配置项')
    return
  }

  const changes = AI_CONFIG_FIELDS
    .map(field => ({ field, value: normalizeFieldValue(field, form[field.key]) }))
    .filter(({ field, value }) => value !== original[field.key])
  if (!changes.length) {
    ElMessage.info('没有需要保存的更改')
    return
  }

  saving.value = true
  try {
    for (const { field, value } of changes) {
      try {
        await updateAiConfig(field.key, value)
        original[field.key] = value
        form[field.key] = value
      } catch (error) {
        errors[field.key] = error.response?.data?.message || '保存失败'
        throw error
      }
    }
    ElMessage.success(`已保存 ${changes.length} 项配置`)
  } catch (error) {
    console.error('[AiConfig] save failed', error)
  } finally {
    saving.value = false
  }
}

loadConfig()
loadProvider()
</script>

<style scoped lang="scss">
.ai-config-view { min-height: 100%; background: #f4f6f7; color: #253540; }
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 24px clamp(20px, 4vw, 48px) 20px; border-bottom: 1px solid #d8e0e5; background: #fff; }
.page-heading h1 { margin: 3px 0 2px; font-size: 25px; letter-spacing: 0; }
.page-heading p { margin: 0; color: #7b8790; font-size: 13px; }
.page-kicker { color: #4f6f82; font-family: Consolas, monospace; font-size: 10px; letter-spacing: 1.4px; }
.page-actions { display: flex; align-items: center; gap: 9px; }
.config-content { padding-bottom: 36px; }
.provider-band { display: grid; grid-template-columns: minmax(210px, 280px) 1fr; gap: 30px; padding: 28px clamp(20px, 4vw, 48px); border-bottom: 1px solid #d8e0e5; background: #f8fafb; }
.provider-panel { min-width: 0; border: 1px solid #d5dee3; background: #fff; }
.provider-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 16px 18px; border-bottom: 1px solid #e1e7ea; }
.provider-heading > div { display: flex; align-items: center; gap: 10px; }
.provider-heading code { overflow-wrap: anywhere; color: #71808a; font-size: 10px; }
.provider-status { color: #8a969e; font-size: 11px; }
.provider-status::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: #9ca7ad; }
.provider-status.is-online { color: #237653; }
.provider-status.is-online::before { background: #2f9a6b; }
.provider-grid { display: grid; grid-template-columns: minmax(260px, 1fr) auto; align-items: center; gap: 16px; padding: 18px; }
.provider-field { display: grid; grid-template-columns: 110px minmax(180px, 1fr); align-items: center; gap: 7px 14px; }
.provider-field > span { font-size: 13px; font-weight: 600; }
.provider-field small { grid-column: 2; color: #7f8b93; font-size: 11px; }
.provider-actions { display: flex; gap: 8px; }
.provider-metrics { display: grid; grid-template-columns: repeat(2, 1fr); border-top: 1px solid #e1e7ea; }
.provider-metrics > div { display: grid; grid-template-columns: 1fr auto; gap: 5px 12px; padding: 16px 18px; }
.provider-metrics > div + div { border-left: 1px solid #e1e7ea; }
.provider-metrics span { color: #556670; font-size: 12px; font-weight: 600; }
.provider-metrics strong { grid-row: 1 / 3; grid-column: 2; align-self: center; font-size: 22px; font-weight: 600; }
.provider-metrics small { color: #859199; font-size: 11px; }
.provider-metrics .el-button { grid-column: 1; justify-self: start; padding: 0; }
.config-band, .safety-band { display: grid; grid-template-columns: minmax(210px, 280px) 1fr; gap: 30px; padding: 28px clamp(20px, 4vw, 48px); border-bottom: 1px solid #d8e0e5; background: #fff; }
.config-band:nth-child(even) { background: #f8fafb; }
.band-intro { display: flex; align-items: flex-start; gap: 14px; }
.band-intro > span { padding-top: 2px; color: #8a969f; font-family: Consolas, monospace; font-size: 12px; }
.band-intro h2 { margin: 0 0 7px; font-size: 17px; }
.band-intro p { max-width: 250px; margin: 0; color: #78848d; font-size: 12px; line-height: 1.6; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 18px 24px; }
.config-field { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(150px, 220px); align-items: center; gap: 7px 16px; min-width: 0; }
.config-field__label { color: #354651; font-size: 13px; font-weight: 600; }
.config-field code { grid-column: 1 / -1; color: #89959e; font-family: Consolas, monospace; font-size: 10px; }
.field-error { grid-column: 1 / -1; color: #c33f3f; }
.safety-band { background: #192a33; color: #eef4f6; }
.safety-band .band-intro h2 { color: #fff; }
.safety-band .band-intro p, .safety-band .band-intro > span { color: #9eb0ba; }
.safety-band ul { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 12px 26px; margin: 0; padding: 0; list-style: none; }
.safety-band li { position: relative; padding: 10px 12px 10px 30px; border-left: 2px solid #d4a449; background: #223742; color: #dce7eb; font-size: 12px; line-height: 1.55; }
.safety-band li::before { content: '✓'; position: absolute; left: 10px; color: #e0b961; }
@media (max-width: 900px) {
  .page-heading { align-items: flex-start; flex-direction: column; }
  .provider-band, .config-band, .safety-band { grid-template-columns: 1fr; gap: 20px; }
  .provider-grid { grid-template-columns: 1fr; }
  .provider-actions { flex-wrap: wrap; }
  .provider-metrics { grid-template-columns: 1fr; }
  .provider-metrics > div + div { border-top: 1px solid #e1e7ea; border-left: 0; }
  .field-grid, .safety-band ul { grid-template-columns: 1fr; }
  .config-field { grid-template-columns: minmax(120px, 1fr) minmax(140px, 1fr); }
}
</style>
