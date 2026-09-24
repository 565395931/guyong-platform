<template>
  <div class="video-generate-view">
    <aside class="video-generate-view__left">
      <div class="video-generate-view__panel-title">
        <el-icon><Film /></el-icon>
        视频营销模板
      </div>
      <div v-loading="templateLoading" class="video-generate-view__template-list">
        <button
          v-for="template in templates"
          :key="template.id"
          type="button"
          class="template-card"
          :class="{ 'template-card--active': selectedTemplate?.id === template.id }"
          @click="selectTemplate(template)"
        >
          <div class="template-card__icon">
            <el-icon><VideoCamera /></el-icon>
          </div>
          <div class="template-card__info">
            <strong>{{ template.name }}</strong>
            <span>{{ template.durationSeconds }}s · {{ template.tone }}</span>
            <p>{{ template.summary }}</p>
          </div>
        </button>
        <el-empty
          v-if="templates.length === 0 && !templateLoading"
          description="暂无视频模板"
          :image-size="72"
        />
      </div>
    </aside>

    <main class="video-generate-view__center">
      <div class="video-generate-view__panel-title">
        <el-icon><Edit /></el-icon>
        内容与素材
      </div>
      <div class="video-generate-view__editor">
        <el-alert
          v-if="selectedTemplate"
          class="video-generate-view__alert"
          type="info"
          :closable="false"
          show-icon
        >
          <template #title>
            {{ selectedTemplate.name }}：{{ selectedTemplate.summary }}
          </template>
        </el-alert>

        <el-form label-position="top" class="video-generate-view__form">
          <div class="video-generate-view__form-grid">
            <el-form-item label="视频标题">
              <el-input
                v-model="videoForm.title"
                maxlength="120"
                show-word-limit
                placeholder="例如：智能杯新品 30 秒亮点"
              />
            </el-form-item>
            <el-form-item label="产品 / 主题">
              <el-input
                v-model="videoForm.productName"
                maxlength="80"
                show-word-limit
                placeholder="例如：智能保温杯"
              />
            </el-form-item>
          </div>

          <div class="video-generate-view__form-grid">
            <el-form-item label="目标人群">
              <el-input
                v-model="videoForm.audience"
                maxlength="120"
                placeholder="例如：老客 / 高意向咨询用户"
              />
            </el-form-item>
            <el-form-item label="发布渠道">
              <el-select v-model="videoForm.channel" placeholder="选择渠道" style="width: 100%">
                <el-option
                  v-for="channel in channelOptions"
                  :key="channel.value"
                  :label="channel.label"
                  :value="channel.value"
                />
              </el-select>
            </el-form-item>
          </div>

          <el-form-item label="核心卖点">
            <el-input
              v-model="videoForm.keyPointsText"
              type="textarea"
              :rows="4"
              placeholder="每行一个卖点，例如：&#10;保温更久&#10;重量更轻&#10;适合通勤和出差"
            />
          </el-form-item>

          <el-form-item label="补充脚本 / 口播素材">
            <el-input
              v-model="videoForm.script"
              type="textarea"
              :rows="4"
              maxlength="1200"
              show-word-limit
              placeholder="可选。已有完整脚本时粘贴到这里，系统会用于生成分镜。"
            />
          </el-form-item>

          <div class="video-generate-view__form-grid">
            <el-form-item label="行动召唤">
              <el-input
                v-model="videoForm.callToAction"
                maxlength="120"
                placeholder="例如：立即咨询，获取完整报价"
              />
            </el-form-item>
            <el-form-item label="背景音乐">
              <el-select v-model="videoForm.bgm" placeholder="选择背景音乐" style="width: 100%">
                <el-option label="动感节奏" value="energetic" />
                <el-option label="促销节奏" value="driving" />
                <el-option label="温暖信任" value="warm" />
                <el-option label="品牌叙事" value="cinematic" />
                <el-option label="轻快自然" value="light" />
                <el-option label="无背景音乐" value="none" />
              </el-select>
            </el-form-item>
          </div>

          <div class="video-generate-view__form-grid">
            <el-form-item label="语气">
              <el-select v-model="videoForm.tone" placeholder="选择语气" style="width: 100%">
                <el-option label="直接转化" value="direct" />
                <el-option label="温暖唤醒" value="warm" />
                <el-option label="专业说明" value="professional" />
                <el-option label="信任背书" value="trustworthy" />
                <el-option label="轻松友好" value="friendly" />
              </el-select>
            </el-form-item>
            <el-form-item label="时长">
              <el-input-number
                v-model="videoForm.durationSeconds"
                :min="6"
                :max="120"
                :step="1"
                style="width: 100%"
              />
            </el-form-item>
          </div>

          <el-form-item label="素材库">
            <div class="media-toolbar">
              <span>已选择 {{ selectedMediaFileIds.length }} 个素材</span>
              <el-upload
                :auto-upload="false"
                :show-file-list="false"
                accept="image/*,video/*"
                :on-change="handleUploadChange"
              >
                <el-button :icon="Upload" :loading="uploading" plain>
                  上传新素材
                </el-button>
              </el-upload>
            </div>

            <div v-loading="mediaLoading" class="media-list">
              <el-checkbox-group v-model="selectedMediaFileIds" class="media-list__group">
                <el-checkbox
                  v-for="file in mediaFiles"
                  :key="file.id"
                  :label="file.id"
                  class="media-item"
                >
                  <span>{{ file.displayName || file.originalName || file.id }}</span>
                  <el-tag size="small" effect="plain">{{ mediaTypeLabel(file.mediaType) }}</el-tag>
                </el-checkbox>
              </el-checkbox-group>
              <el-empty
                v-if="mediaFiles.length === 0 && !mediaLoading"
                description="素材库暂无图片或视频，可先上传"
                :image-size="64"
              />
            </div>
          </el-form-item>

          <el-form-item label="参考备注">
            <el-input
              v-model="videoForm.referenceNotes"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="可选：例如需要突出礼品属性、强调交付速度、避免过度促销感。"
            />
          </el-form-item>
        </el-form>
      </div>
    </main>

    <aside class="video-generate-view__right">
      <div class="video-generate-view__panel-title">
        <el-icon><Monitor /></el-icon>
        生成结果
      </div>
      <div class="video-generate-view__result">
        <div v-if="generatedPlan" class="result-card">
          <div class="result-card__head">
            <div>
              <h3>{{ generatedPlan.title }}</h3>
              <p>{{ generatedPlan.templateName }} · {{ generatedPlan.durationSeconds }}s</p>
            </div>
            <el-tag type="success" effect="light">已生成</el-tag>
          </div>

          <section class="result-block">
            <h4>发布文案</h4>
            <p>{{ generatedPlan.caption }}</p>
            <div class="result-tags">
              <el-tag
                v-for="tag in generatedPlan.hashtags"
                :key="tag"
                size="small"
                effect="plain"
              >
                {{ tag }}
              </el-tag>
            </div>
          </section>

          <section class="result-block">
            <h4>分镜脚本</h4>
            <div
              v-for="scene in generatedPlan.scenes"
              :key="scene.index"
              class="scene-card"
            >
              <div class="scene-card__meta">
                <strong>{{ scene.index }}. {{ scene.label }}</strong>
                <span>{{ scene.durationSeconds }}s</span>
              </div>
              <p>{{ scene.voiceover }}</p>
              <small>字幕：{{ scene.onScreenText }}</small>
              <small>素材：{{ scene.mediaAsset?.displayName || '按模板生成' }}</small>
            </div>
          </section>

          <section class="result-block">
            <h4>承接建议</h4>
            <div class="result-tags">
              <el-tag
                v-for="id in generatedPlan.bridge.recommendedCampaignBlueprintIds"
                :key="id"
                size="small"
                type="warning"
                effect="plain"
              >
                {{ blueprintLabel(id) }}
              </el-tag>
            </div>
          </section>

          <section class="result-block">
            <h4>发布检查</h4>
            <ul>
              <li v-for="item in generatedPlan.publishChecklist" :key="item">
                {{ item }}
              </li>
            </ul>
          </section>
        </div>

        <div v-else class="result-placeholder">
          <el-icon :size="54" color="#c0c4cc"><VideoPlay /></el-icon>
          <h3>生成视频营销方案</h3>
          <p>选择模板、填写卖点并选择素材后，将生成分镜、口播、字幕、发布文案和活动承接建议。</p>
          <div v-if="selectedTemplate" class="template-outline">
            <strong>{{ selectedTemplate.name }} 分镜结构</strong>
            <span
              v-for="scene in selectedTemplate.sceneBlueprints"
              :key="scene.label"
            >
              {{ scene.label }} · {{ scene.durationSeconds }}s
            </span>
          </div>
        </div>
      </div>

      <div class="video-generate-view__actions">
        <el-button
          type="primary"
          size="large"
          :icon="VideoPlay"
          :loading="generating"
          :disabled="!selectedTemplate"
          class="video-generate-view__generate-btn"
          @click="handleGenerate"
        >
          {{ generating ? '生成中...' : '生成方案' }}
        </el-button>
        <template v-if="generatedPlan">
          <el-button :icon="Download" @click="handleExport">导出方案</el-button>
          <el-button plain @click="handleCopyCaption">复制文案</el-button>
        </template>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Film,
  Edit,
  Monitor,
  VideoCamera,
  VideoPlay,
  Download,
  PictureFilled,
  Upload
} from '@element-plus/icons-vue'
import { getVideoTemplates, generateVideo } from '@/api/video'
import { getMediaFiles, uploadMediaFile } from '@/api/messages'

const templateLoading = ref(false)
const mediaLoading = ref(false)
const generating = ref(false)
const uploading = ref(false)
const templates = ref([])
const mediaFiles = ref([])
const selectedTemplateId = ref('')
const selectedMediaFileIds = ref([])
const generatedPlan = ref(null)

const channelOptions = [
  { label: '抖音', value: 'douyin' },
  { label: '快手', value: 'kuaishou' },
  { label: '小红书', value: 'xiaohongshu' },
  { label: 'WhatsApp', value: 'whatsapp' },
  { label: '微信', value: 'wechat' },
  { label: '淘宝', value: 'taobao' },
  { label: '1688', value: 'alibaba1688' },
  { label: '视频号小店', value: 'wechat_shop' }
]

const blueprintNames = {
  new_product_launch: '新品首发',
  dormant_reactivation: '沉默唤醒',
  comment_conversion: '评论转化',
  keyword_capture: '关键词承接',
  repeat_purchase: '复购提升',
  lead_nurture: '线索培育'
}

const videoForm = reactive({
  title: '',
  productName: '',
  audience: '',
  keyPointsText: '',
  script: '',
  callToAction: '',
  bgm: 'energetic',
  tone: 'direct',
  channel: 'douyin',
  durationSeconds: 18,
  referenceNotes: ''
})

const selectedTemplate = computed(() => templates.value.find(item => item.id === selectedTemplateId.value) || null)

function parseList(value) {
  return String(value || '')
    .split(/[\n,，;；]+/g)
    .map(item => item.trim())
    .filter(Boolean)
}

function mediaTypeLabel(type) {
  return {
    image: '图片',
    video: '视频',
    audio: '音频',
    file: '文件'
  }[type] || type
}

function blueprintLabel(id) {
  return blueprintNames[id] || id
}

function selectTemplate(template) {
  selectedTemplateId.value = template.id
  generatedPlan.value = null
  const draft = template.draft || {}

  videoForm.title = draft.title || template.name
  videoForm.audience = draft.audience || template.defaultAudience || ''
  videoForm.tone = draft.tone || template.tone || 'direct'
  videoForm.bgm = draft.bgm || template.defaultBgm || 'energetic'
  videoForm.durationSeconds = draft.durationSeconds || template.durationSeconds || 18
  videoForm.keyPointsText = (draft.keyPoints || template.defaultKeyPoints || []).join('\n')
  videoForm.callToAction = draft.callToAction || template.defaultCallToAction || ''
  videoForm.channel = (template.recommendedChannels || [videoForm.channel])[0] || videoForm.channel
}

async function loadTemplates() {
  templateLoading.value = true
  try {
    const response = await getVideoTemplates()
    templates.value = response.data?.list || []
    if (templates.value.length > 0) selectTemplate(templates.value[0])
  } catch (error) {
    ElMessage.error(error.message || '加载视频模板失败')
  } finally {
    templateLoading.value = false
  }
}

async function loadMediaFiles() {
  mediaLoading.value = true
  try {
    const [imageResponse, videoResponse] = await Promise.all([
      getMediaFiles({ mediaType: 'image', page: 1, pageSize: 100 }),
      getMediaFiles({ mediaType: 'video', page: 1, pageSize: 100 })
    ])
    const map = new Map()
    for (const file of [
      ...(imageResponse.data?.list || []),
      ...(videoResponse.data?.list || [])
    ]) {
      map.set(file.id, file)
    }
    mediaFiles.value = [...map.values()]
  } catch (error) {
    ElMessage.error(error.message || '加载素材库失败')
  } finally {
    mediaLoading.value = false
  }
}

async function handleUploadChange(file) {
  const rawFile = file.raw || file
  if (!rawFile) return

  uploading.value = true
  try {
    const response = await uploadMediaFile(rawFile)
    const savedFile = response.data?.file || response.data?.list?.[0]
    if (savedFile) {
      mediaFiles.value = [savedFile, ...mediaFiles.value.filter(item => item.id !== savedFile.id)]
      selectedMediaFileIds.value = [...new Set([savedFile.id, ...selectedMediaFileIds.value])]
      ElMessage.success('素材上传成功')
    }
  } catch (error) {
    ElMessage.error(error.message || '素材上传失败')
  } finally {
    uploading.value = false
  }
}

function buildPayload() {
  return {
    templateId: selectedTemplate.value?.id,
    title: videoForm.title.trim(),
    productName: videoForm.productName.trim(),
    audience: videoForm.audience.trim(),
    keyPoints: parseList(videoForm.keyPointsText),
    script: videoForm.script.trim(),
    callToAction: videoForm.callToAction.trim(),
    bgm: videoForm.bgm,
    tone: videoForm.tone,
    channel: videoForm.channel,
    durationSeconds: Number(videoForm.durationSeconds),
    mediaFileIds: [...selectedMediaFileIds.value],
    referenceNotes: videoForm.referenceNotes.trim()
  }
}

async function handleGenerate() {
  if (!selectedTemplate.value) {
    ElMessage.warning('请先选择视频模板')
    return
  }
  if (!videoForm.title.trim()) {
    ElMessage.warning('请输入视频标题')
    return
  }

  generating.value = true
  generatedPlan.value = null
  try {
    const response = await generateVideo(buildPayload())
    generatedPlan.value = response.data
    ElMessage.success('视频营销方案已生成')
  } catch (error) {
    ElMessage.error(error.message || '生成失败')
  } finally {
    generating.value = false
  }
}

function handleExport() {
  if (!generatedPlan.value) return

  const blob = new Blob([JSON.stringify(generatedPlan.value, null, 2)], {
    type: 'application/json;charset=utf-8'
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${generatedPlan.value.title || 'video-marketing-plan'}.json`
  link.click()
  URL.revokeObjectURL(url)
}

async function handleCopyCaption() {
  if (!generatedPlan.value) return
  const text = [
    generatedPlan.value.caption,
    '',
    ...(generatedPlan.value.hashtags || [])
  ].join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('发布文案已复制')
  } catch {
    ElMessage.warning('当前浏览器不支持自动复制，请手动选择文案')
  }
}

onMounted(() => {
  loadTemplates()
  loadMediaFiles()
})
</script>

<style scoped lang="scss">
.video-generate-view {
  display: flex;
  height: 100%;
  gap: 16px;
  padding: 20px;
  overflow: hidden;
}

.video-generate-view__left,
.video-generate-view__center,
.video-generate-view__right {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.video-generate-view__left {
  width: 280px;
  flex-shrink: 0;
}

.video-generate-view__center {
  flex: 1;
  min-width: 0;
}

.video-generate-view__right {
  width: 380px;
  flex-shrink: 0;
}

.video-generate-view__panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid #e5e7eb;
  font-size: 15px;
  font-weight: 700;
  color: #111827;
  flex-shrink: 0;
}

.video-generate-view__template-list,
.video-generate-view__editor,
.video-generate-view__result {
  flex: 1;
  overflow-y: auto;
}

.video-generate-view__template-list {
  padding: 12px;
}

.video-generate-view__editor {
  padding: 18px;
}

.video-generate-view__result {
  padding: 16px;
}

.video-generate-view__alert {
  margin-bottom: 16px;
}

.video-generate-view__form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.template-card {
  display: flex;
  gap: 12px;
  width: 100%;
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 10px;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 10px;
}

.template-card:hover {
  border-color: #409eff;
  box-shadow: 0 8px 20px rgba(64, 158, 255, 0.08);
}

.template-card--active {
  border-color: #409eff;
  background: #ecf5ff;
}

.template-card__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #eff6ff;
  color: #2563eb;
  flex-shrink: 0;
}

.template-card__info {
  min-width: 0;
}

.template-card__info strong,
.template-card__info span {
  display: block;
}

.template-card__info strong {
  color: #111827;
  font-size: 14px;
}

.template-card__info span {
  color: #6b7280;
  font-size: 12px;
  margin-top: 3px;
}

.template-card__info p {
  margin: 8px 0 0;
  color: #374151;
  font-size: 12px;
  line-height: 1.5;
}

.media-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  width: 100%;
}

.media-toolbar span {
  color: #6b7280;
  font-size: 13px;
}

.media-list {
  width: 100%;
  min-height: 96px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  background: #f9fafb;
}

.media-list__group {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}

.media-item {
  margin-right: 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px;
  background: #fff;
}

:deep(.media-item .el-checkbox__label) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

:deep(.media-item .el-checkbox__label span:first-child) {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.result-card__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.result-card__head h3 {
  margin: 0;
  color: #111827;
  font-size: 18px;
}

.result-card__head p {
  margin: 6px 0 0;
  color: #6b7280;
  font-size: 13px;
}

.result-block {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e5e7eb;
}

.result-block h4 {
  margin: 0 0 10px;
  color: #111827;
  font-size: 14px;
}

.result-block p {
  margin: 0;
  color: #374151;
  line-height: 1.6;
}

.result-block ul {
  margin: 0;
  padding-left: 18px;
  color: #374151;
  line-height: 1.8;
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.scene-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 10px;
  background: #f9fafb;
}

.scene-card__meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #111827;
}

.scene-card__meta span,
.scene-card small {
  color: #6b7280;
  font-size: 12px;
}

.scene-card p {
  margin: 8px 0;
  color: #374151;
  line-height: 1.6;
}

.scene-card small {
  display: block;
  margin-top: 4px;
}

.result-placeholder {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  color: #6b7280;
  padding: 24px;
}

.result-placeholder h3 {
  color: #111827;
  margin: 14px 0 8px;
}

.result-placeholder p {
  margin: 0;
  line-height: 1.7;
}

.template-outline {
  width: 100%;
  margin-top: 20px;
  padding: 12px;
  border: 1px dashed #cbd5e1;
  border-radius: 10px;
  text-align: left;
}

.template-outline strong,
.template-outline span {
  display: block;
}

.template-outline strong {
  color: #111827;
  margin-bottom: 8px;
}

.template-outline span {
  color: #6b7280;
  font-size: 13px;
  line-height: 1.8;
}

.video-generate-view__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e5e7eb;
}

.video-generate-view__generate-btn {
  flex: 1;
}

@media (max-width: 1180px) {
  .video-generate-view {
    flex-direction: column;
    height: auto;
    overflow: visible;
  }

  .video-generate-view__left,
  .video-generate-view__right {
    width: 100%;
  }
}
</style>

