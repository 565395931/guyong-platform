<template>
  <div class="campaign-create">
    <div class="campaign-create__header">
      <el-button text :icon="ArrowLeft" @click="goBack">返回</el-button>
      <div>
        <h2>新建营销任务</h2>
        <p>先选营销蓝图，再微调渠道、话术和节奏，提交后就会进入执行队列。</p>
      </div>
    </div>

    <section class="campaign-create__section campaign-create__section--blueprints">
      <div class="campaign-create__section-header">
        <div>
          <h3>营销蓝图</h3>
          <p>把常见营销场景做成可复用模板，减少从零开始搭任务的成本。</p>
        </div>
        <el-tag v-if="selectedBlueprint" type="success" effect="light">
          当前选择：{{ selectedBlueprint.name }}
        </el-tag>
      </div>

      <div v-loading="blueprintLoading" class="blueprint-grid">
        <button
          v-for="blueprint in blueprints"
          :key="blueprint.id"
          type="button"
          class="blueprint-card"
          :class="{ 'blueprint-card--active': selectedBlueprintId === blueprint.id }"
          @click="applyBlueprint(blueprint)"
        >
          <div class="blueprint-card__top">
            <div>
              <strong>{{ blueprint.name }}</strong>
              <span>{{ blueprint.goal }}</span>
            </div>
            <el-tag size="small" type="warning" effect="plain">
              {{ blueprint.type }}
            </el-tag>
          </div>

          <p class="blueprint-card__summary">{{ blueprint.summary }}</p>

          <div class="blueprint-card__chips">
            <el-tag
              v-for="channel in blueprint.targetChannels"
              :key="`${blueprint.id}-${channel}`"
              size="small"
              effect="plain"
            >
              {{ channelLabel(channel) }}
            </el-tag>
          </div>

          <div class="blueprint-card__footer">
            <span>推荐视频：{{ blueprint.recommendedVideoTemplate?.name || '无' }}</span>
            <span>{{ blueprint.targetTags.length }} 个标签</span>
          </div>
        </button>
      </div>
    </section>

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="120px"
      class="campaign-create__form"
    >
      <section class="campaign-create__section">
        <h3>任务基础</h3>
        <el-form-item label="任务名称" prop="name">
          <el-input
            v-model="form.name"
            maxlength="120"
            show-word-limit
            placeholder="例如：新品首发 WhatsApp 转化任务"
          />
        </el-form-item>
        <el-form-item label="任务类型" prop="type">
          <el-radio-group v-model="form.type">
            <el-radio-button label="dm">批量私信</el-radio-button>
            <el-radio-button label="comment">评论承接</el-radio-button>
            <el-radio-button label="keyword">关键词触发</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </section>

      <section class="campaign-create__section">
        <h3>目标用户</h3>
        <el-form-item label="目标渠道" prop="targetChannels">
          <el-checkbox-group v-model="form.targetChannels" class="campaign-create__checkboxes">
            <el-checkbox
              v-for="channel in channelOptions"
              :key="channel.value"
              :label="channel.value"
            >
              {{ channel.label }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="目标标签">
          <el-select
            v-model="form.targetTags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入标签后回车，可留空"
            style="width: 100%"
          >
            <el-option label="高意向客户" value="high_intent" />
            <el-option label="复购客户" value="repurchase" />
            <el-option label="沉默客户" value="dormant" />
            <el-option label="新客" value="new_product" />
            <el-option label="线索" value="lead" />
          </el-select>
        </el-form-item>
        <el-form-item label="手工用户 ID">
          <el-input
            v-model="form.manualIds"
            type="textarea"
            :rows="4"
            placeholder="每行一个外部用户 ID，例如：&#10;8613800138000@c.us&#10;8613900139000@c.us"
          />
          <div class="campaign-create__hint">标签和手工用户 ID 至少填一种。</div>
        </el-form-item>
      </section>

      <section class="campaign-create__section">
        <h3>话术与素材</h3>
        <div
          v-for="(script, index) in form.scripts"
          :key="index"
          class="campaign-create__script"
        >
          <el-form-item :label="`话术 ${index + 1}`">
            <el-input
              v-model="script.content"
              type="textarea"
              :rows="4"
              placeholder="例如：你好 {name}，我们刚上新了 {productName}..."
            />
          </el-form-item>
          <el-form-item label="素材文件 ID">
            <el-input
              v-model="script.mediaFileIds"
              placeholder="可选，多个 ID 用逗号或换行分隔"
            />
          </el-form-item>
          <div class="campaign-create__script-actions">
            <el-button
              v-if="form.scripts.length > 1"
              text
              type="danger"
              :icon="Delete"
              @click="removeScript(index)"
            >
              删除话术
            </el-button>
          </div>
        </div>
        <el-button plain :icon="Plus" @click="addScript">新增话术</el-button>
      </section>

      <section class="campaign-create__section">
        <h3>发送设置</h3>
        <el-form-item label="指定账号 ID">
          <el-input
            v-model="form.accountIdsText"
            type="textarea"
            :rows="3"
            placeholder="留空表示使用目标渠道下所有可用账号；多个账号 ID 用逗号或换行分隔。"
          />
        </el-form-item>
        <div class="campaign-create__inline">
          <el-form-item label="每日上限">
            <el-input-number v-model="form.dailyLimit" :min="1" :max="1000" :step="10" />
            <span class="campaign-create__unit">条 / 账号 / 天</span>
          </el-form-item>
          <el-form-item label="发送间隔">
            <el-input-number v-model="form.intervalSeconds" :min="5" :max="3600" :step="5" />
            <span class="campaign-create__unit">秒</span>
          </el-form-item>
        </div>
        <el-form-item label="发送时段">
          <el-time-picker
            v-model="form.sendTimeRange"
            is-range
            format="HH:mm"
            value-format="HH:mm"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
          />
        </el-form-item>
      </section>

      <section class="campaign-create__section campaign-create__preview">
        <h3>提交预览</h3>
        <div class="campaign-create__preview-grid">
          <div>
            <span>蓝图</span>
            <strong>{{ selectedBlueprint?.name || '未选择' }}</strong>
          </div>
          <div>
            <span>推荐视频</span>
            <strong>{{ selectedBlueprint?.recommendedVideoTemplate?.name || '无' }}</strong>
          </div>
          <div>
            <span>目标渠道</span>
            <strong>{{ form.targetChannels.length }} 个</strong>
          </div>
          <div>
            <span>目标标签</span>
            <strong>{{ form.targetTags.length }} 个</strong>
          </div>
          <div>
            <span>手工用户</span>
            <strong>{{ parsedManualIds.length }} 个</strong>
          </div>
          <div>
            <span>话术组</span>
            <strong>{{ parsedScripts.length }} 组</strong>
          </div>
        </div>
      </section>

      <div class="campaign-create__footer">
        <el-button @click="goBack">取消</el-button>
        <el-button type="primary" :icon="Check" :loading="submitting" @click="submit">
          创建任务
        </el-button>
      </div>
    </el-form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Check, Delete, Plus } from '@element-plus/icons-vue'
import { createTask, getCampaignBlueprints } from '@/api/campaigns'

const router = useRouter()
const formRef = ref(null)
const submitting = ref(false)
const blueprintLoading = ref(false)
const blueprints = ref([])
const selectedBlueprintId = ref('')

const channelOptions = [
  { label: 'WhatsApp', value: 'whatsapp' },
  { label: '微信', value: 'wechat' },
  { label: '抖音', value: 'douyin' },
  { label: '拼多多', value: 'pinduoduo' },
  { label: '淘宝', value: 'taobao' },
  { label: '1688', value: 'alibaba1688' },
  { label: '小红书', value: 'xiaohongshu' },
  { label: '视频号小店', value: 'wechat_shop' },
  { label: '快手', value: 'kuaishou' }
]

const form = reactive({
  name: '',
  type: 'dm',
  targetChannels: ['whatsapp'],
  targetTags: [],
  manualIds: '',
  scripts: [{ content: '', mediaFileIds: '' }],
  accountIdsText: '',
  dailyLimit: 100,
  intervalSeconds: 30,
  sendTimeRange: null
})

const rules = {
  name: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择任务类型', trigger: 'change' }],
  targetChannels: [{
    validator: (_, value, callback) => {
      if (!Array.isArray(value) || value.length === 0) callback(new Error('请选择目标渠道'))
      else callback()
    },
    trigger: 'change'
  }]
}

const selectedBlueprint = computed(() => blueprints.value.find(item => item.id === selectedBlueprintId.value) || null)
const parsedManualIds = computed(() => parseList(form.manualIds))
const parsedScripts = computed(() => normalizeScripts())

function parseList(value) {
  return String(value || '')
    .split(/[\n,，;；]+/g)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseAccountIds(value) {
  return [...new Set(parseList(value)
    .map(item => Number(item))
    .filter(item => Number.isSafeInteger(item) && item > 0))]
}

function normalizeScripts() {
  return form.scripts
    .map(script => ({
      content: String(script.content || '').trim(),
      mediaFileIds: parseList(script.mediaFileIds)
    }))
    .filter(script => script.content)
}

function channelLabel(channel) {
  return channelOptions.find(item => item.value === channel)?.label || channel
}

function goBack() {
  router.push('/campaigns')
}

function addScript() {
  form.scripts = [...form.scripts, { content: '', mediaFileIds: '' }]
}

function removeScript(index) {
  form.scripts = form.scripts.filter((_, itemIndex) => itemIndex !== index)
}

function applyBlueprint(blueprint) {
  selectedBlueprintId.value = blueprint.id
  const draft = blueprint.draft || {}

  form.name = draft.name || blueprint.name
  form.type = draft.type || blueprint.type
  form.targetChannels = [...(draft.targetChannels || blueprint.targetChannels || [])]
  form.targetTags = [...(draft.targetTags || blueprint.targetTags || [])]
  form.manualIds = ''
  form.scripts = (draft.scripts || blueprint.scripts || [{ content: '', mediaFileIds: [] }]).map(script => ({
    content: script.content || '',
    mediaFileIds: (script.mediaFileIds || []).join(', ')
  }))
  if (form.scripts.length === 0) {
    form.scripts = [{ content: '', mediaFileIds: '' }]
  }
  form.accountIdsText = (draft.accountIds || []).join(', ')
  form.dailyLimit = draft.dailyLimit || blueprint.dailyLimit || 100
  form.intervalSeconds = draft.intervalSeconds || blueprint.intervalSeconds || 30
  form.sendTimeRange = draft.sendTimeStart && draft.sendTimeEnd
    ? [draft.sendTimeStart, draft.sendTimeEnd]
    : null
}

function buildPayload() {
  const sendTimeStart = Array.isArray(form.sendTimeRange) ? form.sendTimeRange[0] : null
  const sendTimeEnd = Array.isArray(form.sendTimeRange) ? form.sendTimeRange[1] : null

  return {
    name: form.name.trim(),
    type: form.type,
    targetChannels: [...form.targetChannels],
    targetTags: [...new Set(form.targetTags.map(item => String(item).trim()).filter(Boolean))],
    targetUserIds: parsedManualIds.value,
    scripts: parsedScripts.value,
    accountIds: parseAccountIds(form.accountIdsText),
    dailyLimit: Number(form.dailyLimit),
    intervalSeconds: Number(form.intervalSeconds),
    sendTimeStart,
    sendTimeEnd
  }
}

async function loadBlueprints() {
  blueprintLoading.value = true
  try {
    const response = await getCampaignBlueprints()
    blueprints.value = response.data?.list || []
    if (blueprints.value.length > 0 && !selectedBlueprintId.value) {
      applyBlueprint(blueprints.value[0])
    }
  } catch (error) {
    ElMessage.error(error.message || '加载营销蓝图失败')
  } finally {
    blueprintLoading.value = false
  }
}

async function submit() {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }

  const payload = buildPayload()
  if (!payload.targetTags.length && !payload.targetUserIds.length) {
    ElMessage.warning('请至少填写目标标签或手工用户 ID')
    return
  }
  if (!payload.scripts.length) {
    ElMessage.warning('请至少填写一组发送话术')
    return
  }

  submitting.value = true
  try {
    await createTask(payload)
    ElMessage.success('任务已创建并进入执行队列')
    router.push('/campaigns')
  } catch (error) {
    ElMessage.error(error.message || '创建任务失败')
  } finally {
    submitting.value = false
  }
}

onMounted(loadBlueprints)
</script>

<style scoped lang="scss">
.campaign-create {
  padding: 20px;
}

.campaign-create__header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}

.campaign-create__header h2 {
  margin: 0;
  font-size: 20px;
  color: #1f2937;
}

.campaign-create__header p {
  margin: 6px 0 0;
  color: #6b7280;
}

.campaign-create__section {
  padding: 18px 0;
  border-top: 1px solid #e5e7eb;
}

.campaign-create__section h3 {
  margin: 0 0 16px;
  font-size: 16px;
  color: #111827;
}

.campaign-create__section-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.campaign-create__section-header h3 {
  margin-bottom: 4px;
}

.campaign-create__section-header p {
  margin: 0;
  color: #6b7280;
  font-size: 13px;
}

.blueprint-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 12px;
}

.blueprint-card {
  text-align: left;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.blueprint-card:hover {
  border-color: #409eff;
  box-shadow: 0 10px 24px rgba(64, 158, 255, 0.08);
}

.blueprint-card--active {
  border-color: #409eff;
  background: #ecf5ff;
}

.blueprint-card__top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.blueprint-card__top strong {
  display: block;
  font-size: 15px;
  color: #111827;
}

.blueprint-card__top span {
  display: block;
  margin-top: 4px;
  color: #6b7280;
  font-size: 12px;
}

.blueprint-card__summary {
  margin: 10px 0 12px;
  color: #374151;
  font-size: 13px;
  line-height: 1.6;
}

.blueprint-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.blueprint-card__footer {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: #6b7280;
}

.campaign-create__checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.campaign-create__hint {
  width: 100%;
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
}

.campaign-create__script {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px dashed #d1d5db;
}

.campaign-create__script-actions {
  margin-left: 120px;
}

.campaign-create__inline {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
}

.campaign-create__unit {
  margin-left: 8px;
  color: #6b7280;
}

.campaign-create__preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.campaign-create__preview-grid div {
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.campaign-create__preview-grid span {
  display: block;
  margin-bottom: 6px;
  color: #6b7280;
  font-size: 12px;
}

.campaign-create__preview-grid strong {
  color: #111827;
}

.campaign-create__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 18px 0 28px;
  border-top: 1px solid #e5e7eb;
}
</style>

