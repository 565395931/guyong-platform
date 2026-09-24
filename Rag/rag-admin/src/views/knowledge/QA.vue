<template>
  <div class="qa-records-page">
    <div class="page-header">
      <div>
        <h2>AI 推荐 QA 列表</h2>
        <p>沉淀客服工作台 AI 推荐回答的点赞/点踩数据，后续用于整理和更新 RAG 文档。</p>
      </div>
      <el-button :icon="Refresh" @click="fetchList">刷新</el-button>
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form :inline="true" :model="query" @submit.prevent>
        <el-form-item label="反馈">
          <el-select v-model="query.feedback" style="width: 130px" @change="resetAndFetch">
            <el-option label="全部" value="all" />
            <el-option label="点赞" value="up" />
            <el-option label="点踩" value="down" />
            <el-option label="未反馈" value="none" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" style="width: 140px" @change="resetAndFetch">
            <el-option label="全部" value="all" />
            <el-option label="待处理" value="pending" />
            <el-option label="已采纳" value="accepted" />
            <el-option label="已拒绝" value="rejected" />
            <el-option label="已导出" value="exported" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="query.q" clearable placeholder="搜索问题/答案/客户" style="width: 260px" @keyup.enter="resetAndFetch" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="resetAndFetch">查询</el-button>
          <el-button @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="records" row-key="id" style="width: 100%">
        <el-table-column label="反馈" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="feedbackTagType(row.feedback)" effect="plain">{{ feedbackLabel(row.feedback) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-select v-model="row.status" size="small" @change="status => updateStatus(row, status)">
              <el-option label="待处理" value="pending" />
              <el-option label="已采纳" value="accepted" />
              <el-option label="已拒绝" value="rejected" />
              <el-option label="已导出" value="exported" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="适用范围" width="130">
          <template #default="{ row }">
            <el-select v-model="row.knowledgeScope" size="small" @change="value => updateKnowledgeScope(row, value)">
              <el-option v-for="item in knowledgeScopeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="问题" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">{{ row.question }}</template>
        </el-table-column>
        <el-table-column label="推荐回答" min-width="320" show-overflow-tooltip>
          <template #default="{ row }">{{ row.answer }}</template>
        </el-table-column>
        <el-table-column label="中文版本" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.answer_cn || '-' }}</template>
        </el-table-column>
        <el-table-column label="客户/渠道" width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="meta-cell">
              <div>{{ row.user_name || row.user_id || '-' }}</div>
              <small>{{ row.channel || '-' }} / {{ row.account_name || '-' }}</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="模型" prop="model" width="150" show-overflow-tooltip />
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatTime(row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="viewDetail(row)">详情</el-button>
            <el-button link type="primary" @click="copyQA(row)">复制QA</el-button>
            <el-button link type="danger" @click="deleteQA(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="fetchList"
          @current-change="fetchList"
        />
      </div>
    </el-card>

    <el-dialog v-model="detailVisible" title="QA 详情" width="760px">
      <template v-if="current">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="反馈">{{ feedbackLabel(current.feedback) }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusLabel(current.status) }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ current.user_name || current.user_id || '-' }}</el-descriptions-item>
          <el-descriptions-item label="模型">{{ current.model || '-' }}</el-descriptions-item>
          <el-descriptions-item label="适用范围">{{ scopeLabel(current.knowledgeScope) }}</el-descriptions-item>
          <el-descriptions-item label="适用渠道">{{ channelLabels(current.knowledgeChannels).join(' / ') }}</el-descriptions-item>
          <el-descriptions-item label="消息ID" :span="2">{{ current.message_id }}</el-descriptions-item>
          <el-descriptions-item label="会话ID" :span="2">{{ current.conversation_id }}</el-descriptions-item>
        </el-descriptions>
        <div class="detail-section">
          <h4>问题</h4>
          <pre>{{ current.question }}</pre>
        </div>
        <div class="detail-section">
          <h4>推荐回答</h4>
          <pre>{{ current.answer }}</pre>
        </div>
        <div v-if="current.answer_cn" class="detail-section">
          <h4>中文版本</h4>
          <pre>{{ current.answer_cn }}</pre>
        </div>
        <div class="detail-section">
          <h4>点赞上下文</h4>
          <div v-if="current.contextMessages && current.contextMessages.length" class="context-list">
            <div v-for="message in current.contextMessages" :key="message.id || message.createdAt" class="context-item">
              <div class="context-item__meta">
                <el-tag size="small" :type="contextTagType(message)" effect="plain">{{ contextSenderLabel(message) }}</el-tag>
                <span>{{ formatTime(message.createdAt) }}</span>
              </div>
              <pre>{{ contextMessageText(message) }}</pre>
            </div>
          </div>
          <span v-else class="empty-text">无</span>
        </div>
        <div class="detail-section">
          <h4>检索来源</h4>
          <el-tag v-for="source in current.sources || []" :key="source.docName || source.source" class="source-tag" effect="plain">
            {{ source.docName || source.source || 'knowledge' }}
          </el-tag>
          <span v-if="!current.sources || current.sources.length === 0" class="empty-text">无</span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Refresh } from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

const loading = ref(false)
const records = ref([])
const total = ref(0)
const detailVisible = ref(false)
const current = ref(null)
const knowledgeScopeOptions = [
  { label: '通用', value: 'common' },
  { label: '海外业务', value: 'overseas' },
  { label: '国内业务', value: 'domestic' },
  { label: '渠道专用', value: 'channel' }
]

const query = reactive({
  page: 1,
  pageSize: 20,
  feedback: 'all',
  status: 'all',
  q: ''
})

const fetchList = async () => {
  loading.value = true
  try {
    const res = await adminApi.getQAList({ ...query })
    records.value = res.data?.data?.list || []
    total.value = res.data?.data?.total || 0
  } catch (error) {
    ElMessage.error('获取 QA 列表失败: ' + (error.response?.data?.message || error.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

const resetAndFetch = () => {
  query.page = 1
  fetchList()
}

const resetQuery = () => {
  query.page = 1
  query.pageSize = 20
  query.feedback = 'all'
  query.status = 'all'
  query.q = ''
  fetchList()
}

const updateStatus = async (row, status) => {
  try {
    await adminApi.updateQARecord(row.id, { status })
    ElMessage.success('状态已更新')
  } catch (error) {
    ElMessage.error('状态更新失败')
    fetchList()
  }
}

const updateKnowledgeScope = async (row, knowledgeScope) => {
  try {
    const knowledgeChannels = row.knowledgeChannels?.length ? row.knowledgeChannels : defaultChannelsForScope(knowledgeScope, row.channel)
    await adminApi.updateQARecord(row.id, { knowledgeScope, knowledgeChannels })
    row.knowledgeChannels = knowledgeChannels
    ElMessage.success('适用范围已更新')
  } catch (error) {
    ElMessage.error('适用范围更新失败')
    fetchList()
  }
}

const viewDetail = (row) => {
  current.value = row
  detailVisible.value = true
}

const copyQA = async (row) => {
  const text = `Q: ${row.question}\n\nA: ${row.answer}${row.answer_cn ? `\n\n中文版本:\n${row.answer_cn}` : ''}`
  await navigator.clipboard.writeText(text)
  ElMessage.success('已复制 QA')
}

const deleteQA = async (row) => {
  try {
    await ElMessageBox.confirm('确认删除这条 QA 记录吗？删除后无法恢复。', '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    })
    await adminApi.deleteQARecord(row.id)
    ElMessage.success('QA 记录已删除')
    if (records.value.length === 1 && query.page > 1) query.page -= 1
    await fetchList()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error('删除失败: ' + (error.response?.data?.message || error.message || '未知错误'))
    }
  }
}

const feedbackLabel = (value) => ({ up: '点赞', down: '点踩', none: '未反馈' }[value] || value || '-')
const feedbackTagType = (value) => ({ up: 'success', down: 'danger', none: 'info' }[value] || 'info')
const statusLabel = (value) => ({ pending: '待处理', accepted: '已采纳', rejected: '已拒绝', exported: '已导出' }[value] || value || '-')
const scopeLabel = (value) => knowledgeScopeOptions.find(item => item.value === value)?.label || value || '-'
const channelLabels = (channels = []) => {
  const map = { all: '全部', whatsapp: 'WhatsApp', wechat: '微信', douyin: '抖音' }
  return (channels && channels.length ? channels : ['all']).map(channel => map[channel] || channel)
}
const contextSenderLabel = (message = {}) => {
  if (message.direction === 'inbound') return '客户'
  if (message.senderType === 'ai') return 'AI'
  if (message.senderType === 'agent') return '客服'
  return message.direction === 'outbound' ? '外发' : '消息'
}
const contextTagType = (message = {}) => {
  if (message.direction === 'inbound') return 'success'
  if (message.senderType === 'ai') return 'warning'
  if (message.senderType === 'agent') return 'primary'
  return 'info'
}
const contextMessageText = (message = {}) => {
  if (message.text) return message.text
  const content = message.content
  if (!content) return '[非文本消息]'
  if (typeof content === 'string') return content
  return content.text || content.content || content.caption || content.fileName || content.filename || '[非文本消息]'
}
const defaultChannelsForScope = (scope, channel) => {
  if (scope === 'channel' && channel) return [channel]
  return ['all']
}
const formatTime = (time) => {
  if (!time) return '-'
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (num) => String(num).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

onMounted(fetchList)
</script>

<style scoped lang="scss">
.qa-records-page {
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;

    h2 { margin: 0 0 6px; color: #1e293b; }
    p { margin: 0; color: #64748b; font-size: 14px; }
  }

  .filter-card { margin-bottom: 16px; }
  .table-card { min-height: 420px; }
  .pagination-wrap { display: flex; justify-content: flex-end; margin-top: 16px; }

  .meta-cell {
    line-height: 1.4;
    small { color: #94a3b8; }
  }

  .detail-section {
    margin-top: 16px;
    h4 { margin: 0 0 8px; color: #334155; }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 8px;
      background: #f8fafc;
      color: #334155;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
    }
  }

  .source-tag { margin: 0 8px 8px 0; }
  .empty-text { color: #94a3b8; }

  .context-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .context-item {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 10px;
    background: #fff;

    &__meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      color: #64748b;
      font-size: 12px;
    }

    pre {
      background: #f8fafc;
    }
  }
}
</style>
