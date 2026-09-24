<template>
  <div class="test-tool">
    <el-card shadow="never" class="gateway-card">
      <template #header>
        <div class="card-header gateway-header">
          <div class="gateway-title">
            <el-icon><Connection /></el-icon>
            <span>云网关消息测试</span>
          </div>
          <div class="gateway-status">
            <el-tooltip
              :content="gatewayStatus?.gateway?.status === 'ok'
                ? '8788 健康检查通过；表示网关服务可用，不代表真实平台已接入'
                : '8788 健康检查失败，请检查网关进程和 HTTP 端口'"
              placement="bottom"
              :show-after="300"
            >
              <el-tag
                :type="gatewayStatus?.gateway?.status === 'ok' ? 'success' : 'danger'"
                size="small"
                class="status-tag"
              >
                <el-icon><component :is="gatewayStatus?.gateway?.status === 'ok' ? CircleCheckFilled : WarningFilled" /></el-icon>
                <span class="status-label">网关服务</span>
                <span class="status-value">{{ gatewayStatus?.gateway?.status === 'ok' ? '正常' : '异常' }}</span>
              </el-tag>
            </el-tooltip>
            <el-tooltip
              :content="gatewayStatus?.ragLink?.ready
                ? 'Rag 3001 已通过认证连接网关 8787 WebSocket，可收发事件和 ACK'
                : 'Rag 尚未完成网关 WebSocket 认证连接'"
              placement="bottom"
              :show-after="300"
            >
              <el-tag
                :type="gatewayStatus?.ragLink?.ready ? 'success' : 'warning'"
                size="small"
                effect="plain"
                class="status-tag"
              >
                <el-icon><LinkIcon /></el-icon>
                <span class="status-label">Rag 通道</span>
                <span class="status-value">{{ gatewayStatus?.ragLink?.ready ? '已连接' : '未连接' }}</span>
              </el-tag>
            </el-tooltip>
            <el-tooltip
              v-if="gatewayStatus?.gateway?.storeDriver"
              :content="storeDriverTip(gatewayStatus.gateway.storeDriver)"
              placement="bottom"
              :show-after="300"
            >
              <el-tag size="small" effect="plain" class="status-tag">
                <el-icon><FolderOpened /></el-icon>
                <span class="status-label">事件存储</span>
                <span class="status-value">{{ storeDriverLabel(gatewayStatus.gateway.storeDriver) }}</span>
              </el-tag>
            </el-tooltip>
            <el-tooltip
              :content="credentialSourceTip(gatewayStatus?.credential?.source)"
              placement="bottom"
              :show-after="300"
            >
              <el-tag
                :type="gatewayStatus?.credential?.configured ? 'success' : 'danger'"
                size="small"
                effect="plain"
                class="status-tag"
              >
                <el-icon><Key /></el-icon>
                <span class="status-label">鉴权凭据</span>
                <span class="status-value">{{ credentialSourceLabel(gatewayStatus?.credential?.source) }}</span>
              </el-tag>
            </el-tooltip>
            <el-tooltip content="刷新连接状态" placement="bottom" :show-after="300">
              <el-button
                text
                :loading="gatewayLoading"
                class="status-refresh"
                aria-label="刷新连接状态"
                @click="loadGatewayStatus(true)"
              >
                <el-icon><Refresh /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </div>
      </template>

      <el-alert
        v-if="gatewayError"
        :title="gatewayError"
        type="error"
        show-icon
        :closable="false"
        class="gateway-error"
      />

      <el-form label-position="top" class="gateway-form">
        <div class="gateway-form-grid">
          <el-form-item label="测试操作">
            <el-select v-model="mockForm.operation" style="width: 100%">
              <el-option label="Mock 入站消息" value="mock.inbound" />
            </el-select>
          </el-form-item>
          <el-form-item label="测试渠道">
            <el-select
              v-model="mockForm.channel"
              placeholder="选择渠道"
              style="width: 100%"
              @change="handleMockChannelChange"
            >
              <el-option
                v-for="channel in gatewayChannels"
                :key="channel.code"
                :label="`${channel.label} · ${channel.code}`"
                :value="channel.code"
              />
            </el-select>
          </el-form-item>
        </div>
        <div class="gateway-form-grid gateway-form-grid--three">
          <el-form-item label="Mock 账号">
            <div class="gateway-account-control">
              <el-select
                v-model="mockForm.accountId"
                placeholder="创建或选择 Mock 账号"
                filterable
                style="width: 100%"
              >
                <el-option
                  v-for="account in filteredGatewayAccounts"
                  :key="account.id"
                  :label="`${account.accountName} · #${account.id}`"
                  :value="account.id"
                />
              </el-select>
              <el-tooltip content="创建或加载 Mock 账号" placement="top">
                <el-button
                  :icon="Plus"
                  :loading="mockAccountCreating"
                  :disabled="!mockForm.channel"
                  aria-label="创建或加载 Mock 账号"
                  @click="createMockAccount"
                />
              </el-tooltip>
            </div>
          </el-form-item>
          <el-form-item label="客户 ID">
            <el-input v-model="mockForm.channelUserId" maxlength="191" placeholder="mock-customer-1" />
          </el-form-item>
          <el-form-item label="消息类型">
            <el-select v-model="mockForm.messageType" style="width: 100%">
              <el-option
                v-for="messageType in gatewayMessageTypes"
                :key="messageType"
                :label="messageType"
                :value="messageType"
              />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item v-if="mockForm.messageType === 'text'" label="消息正文">
          <el-input
            v-model="mockForm.text"
            type="textarea"
            :rows="3"
            maxlength="10000"
            show-word-limit
          />
        </el-form-item>
        <el-form-item :label="mockForm.messageType === 'text' ? '扩展 Content (JSON)' : '消息 Content (JSON)'">
          <el-input
            v-model="mockForm.contentJson"
            type="textarea"
            :rows="5"
            resize="vertical"
            spellcheck="false"
            class="json-input"
          />
        </el-form-item>
        <el-collapse class="gateway-advanced">
          <el-collapse-item title="稳定 ID 与时间戳" name="ids">
            <div class="gateway-form-grid">
              <el-form-item label="eventId">
                <el-input v-model="mockForm.eventId" maxlength="191" clearable />
              </el-form-item>
              <el-form-item label="channelMessageId">
                <el-input v-model="mockForm.channelMessageId" maxlength="191" clearable />
              </el-form-item>
            </div>
            <el-form-item label="clientTimestamp (Unix ms)">
              <el-input-number
                v-model="mockForm.clientTimestamp"
                :min="1"
                :step="1000"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-collapse-item>
        </el-collapse>
        <div class="gateway-actions">
          <el-button
            type="primary"
            :loading="mockSubmitting"
            :disabled="filteredGatewayAccounts.length === 0 || !gatewayStatus?.credential?.configured"
            @click="submitGatewayRequest"
          >
            <el-icon><Promotion /></el-icon>
            提交测试消息
          </el-button>
        </div>
      </el-form>

      <el-descriptions v-if="mockResult" :column="2" border size="small" class="gateway-result">
        <el-descriptions-item label="eventId">
          <span class="mono">{{ mockResult.eventId }}</span>
          <el-button text size="small" @click="copyEventId">
            <el-icon><CopyDocument /></el-icon>
          </el-button>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="gatewayEventTagType(mockResult.status)" size="small">
            {{ mockResult.status || 'pending' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="投递次数">{{ mockResult.deliveryAttempt ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="ACK">{{ mockResult.ackStatus || '-' }}</el-descriptions-item>
        <el-descriptions-item label="messageId">{{ mockResult.ackResult?.messageId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="conversationId">
          <span class="mono">{{ mockResult.ackResult?.conversationId || '-' }}</span>
          <el-button
            v-if="mockResult.ackResult?.conversationId"
            text
            type="primary"
            size="small"
            @click="openMockConversation"
          >
            打开
          </el-button>
        </el-descriptions-item>
        <el-descriptions-item v-if="mockResult.lastError" label="最近错误" :span="2">
          {{ mockResult.lastError }}
        </el-descriptions-item>
        <el-descriptions-item v-if="mockResult.deadLetterReason" label="死信原因" :span="2">
          {{ mockResult.deadLetterReason }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 搜索区 -->
    <el-card shadow="never" class="search-card">
      <template #header>
        <div class="card-header">
          <el-icon><Search /></el-icon>
          <span>查找测试会话</span>
        </div>
      </template>
      <div class="search-area">
        <el-autocomplete
          v-model="searchInput"
          :fetch-suggestions="querySearchHistory"
          :trigger-on-focus="true"
          placeholder="输入会话 UUID 或外部用户 ID（如 WhatsApp 号码）"
          clearable
          @keyup.enter="handleSearch"
          @select="handleHistorySelect"
          style="width: 420px"
          popper-class="search-history-popper"
        >
          <template #prepend>
            <el-select v-model="searchType" style="width: 110px">
              <el-option label="会话UUID" value="uuid" />
              <el-option label="用户ID" value="userId" />
            </el-select>
          </template>
          <template #default="{ item }">
            <div class="history-item">
              <span class="history-value">{{ item.value }}</span>
              <el-button
                class="history-delete-btn"
                text
                size="small"
                @click.stop="removeHistoryItem(item.value)"
              >
                <el-icon><Close /></el-icon>
              </el-button>
            </div>
          </template>
        </el-autocomplete>
        <el-button type="primary" :loading="searchLoading" @click="handleSearch">
          <el-icon><Search /></el-icon> 查找
        </el-button>
        <el-button
          v-if="searchHistory.length > 0"
          text
          type="danger"
          size="small"
          @click="clearAllHistory"
        >
          清空历史
        </el-button>
      </div>

      <!-- user_id 搜索结果列表 -->
      <div v-if="searchResults.length > 0" class="search-results">
        <div class="results-title">找到 {{ searchResults.length }} 个会话，点击选择：</div>
        <el-table :data="searchResults" size="small" @row-click="selectConversation" highlight-current-row style="cursor: pointer">
          <el-table-column prop="id" label="会话 UUID" width="320" show-overflow-tooltip />
          <el-table-column prop="channel" label="渠道" width="100" />
          <el-table-column prop="user_name" label="用户名" width="120" />
          <el-table-column prop="pool_type" label="池类型" width="120">
            <template #default="{ row }">
              <el-tag :type="poolTagType(row.pool_type)" size="small">{{ row.pool_type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="conv_status" label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.conv_status)" size="small" effect="plain">{{ row.conv_status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="last_message" label="最后消息" show-overflow-tooltip />
          <el-table-column prop="updated_at" label="更新时间" width="160" />
        </el-table>
      </div>
    </el-card>

    <!-- 会话详情 -->
    <template v-if="convData">
      <!-- 会话信息 + 消息统计 -->
      <el-card shadow="never" class="detail-card">
        <template #header>
          <div class="card-header">
            <el-icon><InfoFilled /></el-icon>
            <span>会话状态</span>
            <el-tag size="small" style="margin-left: 8px">{{ convData.conversation.id }}</el-tag>
          </div>
        </template>

        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">渠道</span>
            <span class="info-value">{{ convData.conversation.channel }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">外部用户ID</span>
            <span class="info-value">{{ convData.conversation.user_id || '-' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">用户名</span>
            <span class="info-value">{{ convData.conversation.user_name || '-' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">账号ID</span>
            <span class="info-value">{{ convData.conversation.account_id ?? '-' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">池类型</span>
            <el-tag :type="poolTagType(convData.conversation.pool_type)" size="small">{{ convData.conversation.pool_type }}</el-tag>
          </div>
          <div class="info-item">
            <span class="info-label">会话状态</span>
            <el-tag :type="statusTagType(convData.conversation.conv_status)" size="small" effect="plain">{{ convData.conversation.conv_status }}</el-tag>
          </div>
          <div class="info-item">
            <span class="info-label">认领坐席</span>
            <span class="info-value">{{ convData.conversation.claimed_by ?? '-' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">最后回复方</span>
            <el-tag :type="replyByTagType(convData.conversation.last_reply_by)" size="small" effect="plain">{{ convData.conversation.last_reply_by || '-' }}</el-tag>
          </div>
          <div class="info-item">
            <span class="info-label">未读数</span>
            <span class="info-value">{{ convData.conversation.unread_count }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">创建时间</span>
            <span class="info-value">{{ convData.conversation.created_at }}</span>
          </div>
        </div>

        <el-divider content-position="left">消息统计</el-divider>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-num">{{ convData.stats.total_messages || 0 }}</div>
            <div class="stat-label">总消息</div>
          </div>
          <div class="stat-box stat-customer">
            <div class="stat-num">{{ convData.stats.customer_msg_count || 0 }}</div>
            <div class="stat-label">客户消息</div>
          </div>
          <div class="stat-box stat-ai">
            <div class="stat-num">{{ convData.stats.ai_reply_count || 0 }}</div>
            <div class="stat-label">AI回复</div>
          </div>
          <div class="stat-box stat-agent">
            <div class="stat-num">{{ convData.stats.agent_reply_count || 0 }}</div>
            <div class="stat-label">人工回复</div>
          </div>
        </div>
      </el-card>

      <!-- 操作区 -->
      <el-card shadow="never" class="action-card">
        <template #header>
          <div class="card-header">
            <el-icon><Tools /></el-icon>
            <span>测试操作</span>
          </div>
        </template>

        <!-- 快捷操作 -->
        <div class="action-section">
          <div class="section-title">快捷操作</div>
          <div class="action-buttons">
            <el-button type="warning" @click="confirmAction('resetToNew')">
              <el-icon><RefreshRight /></el-icon> 重置为新客户
            </el-button>
            <el-button type="danger" plain @click="confirmAction('clearMessages')">
              <el-icon><Delete /></el-icon> 清除所有消息
            </el-button>
            <el-button type="danger" plain @click="confirmAction('clearPoolLogs')">
              <el-icon><Delete /></el-icon> 清除池操作日志
            </el-button>
            <el-button type="danger" plain @click="confirmAction('clearAiLogs')">
              <el-icon><Delete /></el-icon> 清除AI回复日志
            </el-button>
            <el-button type="danger" @click="confirmAction('deleteConversation')">
              <el-icon><DeleteFilled /></el-icon> 彻底删除会话
            </el-button>
          </div>
        </div>

        <el-divider />

        <!-- 手动设置池类型 -->
        <div class="action-section">
          <div class="section-title">手动设置会话池</div>
          <div class="pool-setter">
            <el-select v-model="poolForm.poolType" placeholder="选择池类型" style="width: 180px" clearable>
              <el-option label="AI自助池 (ai_self)" value="ai_self" />
              <el-option label="待人工池 (pending_human)" value="pending_human" />
              <el-option label="公共池 (public)" value="public" />
              <el-option label="私有池 (private)" value="private" />
              <el-option label="长期池 (long_term)" value="long_term" />
            </el-select>
            <el-select v-model="poolForm.convStatus" placeholder="选择会话状态" style="width: 200px" clearable>
              <el-option label="AI服务中 (ai_serving)" value="ai_serving" />
              <el-option label="待认领 (pending_claim)" value="pending_claim" />
              <el-option label="处理中 (handling)" value="handling" />
              <el-option label="跟进中 (following)" value="following" />
              <el-option label="已归档 (archived)" value="archived" />
            </el-select>
            <el-button type="primary" :loading="poolLoading" @click="handleSetPool">应用</el-button>
          </div>
          <div class="config-tip">手动将当前会话设置到指定池和状态，用于测试不同池间的流转逻辑。会记录一条池操作日志。</div>
        </div>
      </el-card>

      <!-- 最近消息预览 -->
      <el-card shadow="never" class="preview-card" v-if="convData.recentMessages?.length > 0">
        <template #header>
          <div class="card-header">
            <el-icon><ChatLineSquare /></el-icon>
            <span>最近消息预览（最多5条）</span>
          </div>
        </template>
        <div class="msg-list">
          <div v-for="(msg, idx) in convData.recentMessages" :key="idx" class="msg-item">
            <div class="msg-meta">
              <el-tag :type="msg.direction === 'inbound' ? 'success' : 'warning'" size="small">
                {{ msg.direction === 'inbound' ? '客户' : '发出' }}
              </el-tag>
              <el-tag v-if="msg.sender_type" :type="senderTagType(msg.sender_type)" size="small" effect="plain" style="margin-left: 4px">
                {{ msg.sender_type }}
              </el-tag>
              <span class="msg-type">{{ msg.message_type }}</span>
              <span class="msg-time">{{ formatTime(msg.created_at) }}</span>
            </div>
            <div class="msg-content">{{ extractText(msg.content) }}</div>
          </div>
        </div>
      </el-card>

      <!-- 池操作日志 -->
      <el-card shadow="never" class="preview-card" v-if="convData.poolLogs?.length > 0">
        <template #header>
          <div class="card-header">
            <el-icon><List /></el-icon>
            <span>池操作日志（最近10条）</span>
          </div>
        </template>
        <el-timeline>
          <el-timeline-item
            v-for="(log, idx) in convData.poolLogs"
            :key="idx"
            :timestamp="log.created_at"
            :type="logActionType(log.action)"
          >
            <div class="log-entry">
              <strong>{{ log.action }}</strong>
              <span v-if="log.from_pool" class="log-flow">{{ log.from_pool }} → {{ log.to_pool }}</span>
              <span v-else class="log-flow">→ {{ log.to_pool || '-' }}</span>
              <span class="log-operator">[{{ log.operator_type }}] {{ log.operator_name || '-' }}</span>
              <div v-if="log.reason" class="log-reason">{{ log.reason }}</div>
            </div>
          </el-timeline-item>
        </el-timeline>
      </el-card>
    </template>

    <!-- 空状态 -->
    <el-card shadow="never" v-if="!convData && !searchLoading && hasSearched" class="empty-card">
      <el-empty description="未找到会话，请检查输入的 UUID 或用户 ID" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Search, InfoFilled, Tools, RefreshRight, Delete, DeleteFilled,
  ChatLineSquare, List, Close, Connection, Promotion, Refresh, CopyDocument, Plus,
  CircleCheckFilled, WarningFilled, FolderOpened, Key, Link as LinkIcon
} from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

// ========== 搜索历史记忆 ==========
const HISTORY_KEY = 'testtool_search_history'
const MAX_HISTORY = 50

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
}

const searchHistory = ref(loadHistory())

function addToHistory(keyword) {
  if (!keyword) return
  // 去重：先移除已有相同项，再插入到最前面
  searchHistory.value = [keyword, ...searchHistory.value.filter(h => h !== keyword)]
  // 限制最大数量
  if (searchHistory.value.length > MAX_HISTORY) {
    searchHistory.value = searchHistory.value.slice(0, MAX_HISTORY)
  }
  saveHistory(searchHistory.value)
}

function removeHistoryItem(keyword) {
  searchHistory.value = searchHistory.value.filter(h => h !== keyword)
  saveHistory(searchHistory.value)
}

function clearAllHistory() {
  searchHistory.value = []
  saveHistory(searchHistory.value)
}

function querySearchHistory(queryString, cb) {
  const results = queryString
    ? searchHistory.value.filter(h => h.toLowerCase().includes(queryString.toLowerCase()))
    : [...searchHistory.value]
  cb(results.map(v => ({ value: v })))
}

function handleHistorySelect(item) {
  searchInput.value = item.value
}

// 搜索
const searchType = ref('uuid')
const searchInput = ref('')
const searchLoading = ref(false)
const searchResults = ref([])
const hasSearched = ref(false)

// 会话数据
const convData = ref(null)
const currentConvId = ref('')

// 池设置表单
const poolForm = reactive({
  poolType: '',
  convStatus: ''
})
const poolLoading = ref(false)

// ========== 云网关入站测试 ==========
const gatewayLoading = ref(false)
const gatewayStatus = ref(null)
const gatewayAccounts = ref([])
const gatewayChannels = ref([])
const gatewayMessageTypes = ref(['text', 'image', 'video', 'audio', 'file'])
const gatewayError = ref('')
const mockAccountCreating = ref(false)
const mockSubmitting = ref(false)
const mockResult = ref(null)
const mockForm = reactive({
  operation: 'mock.inbound',
  channel: 'wechat',
  accountId: null,
  channelUserId: 'mock-customer-1',
  messageType: 'text',
  text: '这是一条手动 Mock 入站消息',
  contentJson: '{}',
  eventId: '',
  channelMessageId: '',
  clientTimestamp: Date.now()
})
let eventPollTimer = null
const filteredGatewayAccounts = computed(() => gatewayAccounts.value.filter(account => account.channel === mockForm.channel))

function selectAccountForChannel() {
  if (!filteredGatewayAccounts.value.some(account => account.id === mockForm.accountId)) {
    mockForm.accountId = filteredGatewayAccounts.value[0]?.id || null
  }
}

function handleMockChannelChange() {
  selectAccountForChannel()
}

async function loadGatewayStatus(showMessage = false) {
  gatewayLoading.value = true
  gatewayError.value = ''
  try {
    const res = await adminApi.testTool.getCloudGatewayStatus()
    gatewayStatus.value = res.data?.data || null
    gatewayAccounts.value = res.data?.data?.accounts || []
    gatewayChannels.value = res.data?.data?.channels || []
    gatewayMessageTypes.value = res.data?.data?.capabilities?.messageTypes || gatewayMessageTypes.value
    if (!gatewayChannels.value.some(channel => channel.code === mockForm.channel)) {
      mockForm.channel = gatewayChannels.value[0]?.code || ''
    }
    selectAccountForChannel()
  } catch (error) {
    gatewayStatus.value = null
    gatewayAccounts.value = []
    gatewayError.value = error.response?.data?.message || error.message
    if (showMessage) ElMessage.error(gatewayError.value)
  } finally {
    gatewayLoading.value = false
  }
}

async function createMockAccount() {
  if (!mockForm.channel) return ElMessage.warning('请选择测试渠道')
  const channel = gatewayChannels.value.find(item => item.code === mockForm.channel)
  try {
    await ElMessageBox.confirm(
      `将在 Rag 本地数据库创建或复用“${channel?.label || mockForm.channel}”云网关 Mock 账号。`,
      '创建 Mock 账号',
      { type: 'warning', confirmButtonText: '确认创建', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  mockAccountCreating.value = true
  try {
    const res = await adminApi.testTool.createCloudGatewayMockAccount(mockForm.channel)
    const account = res.data?.data
    await loadGatewayStatus()
    mockForm.accountId = account?.accountId || mockForm.accountId
    ElMessage.success(account?.created ? 'Mock 账号已创建' : '已加载现有 Mock 账号')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message)
  } finally {
    mockAccountCreating.value = false
  }
}

function parseMockContent() {
  let content
  try {
    content = JSON.parse(mockForm.contentJson || '{}')
  } catch {
    throw new Error('Content 必须是有效 JSON')
  }
  if (!content || Array.isArray(content) || typeof content !== 'object') {
    throw new Error('Content 必须是 JSON 对象')
  }
  if (mockForm.messageType === 'text') content.text = mockForm.text.trim()
  return content
}

async function submitGatewayRequest() {
  if (!mockForm.accountId) return ElMessage.warning('请选择测试账号')
  if (!mockForm.channelUserId.trim()) return ElMessage.warning('请输入客户 ID')
  if (mockForm.messageType === 'text' && !mockForm.text.trim()) return ElMessage.warning('请输入消息正文')
  let content
  try {
    content = parseMockContent()
  } catch (error) {
    return ElMessage.warning(error.message)
  }
  mockSubmitting.value = true
  clearTimeout(eventPollTimer)
  try {
    const res = await adminApi.testTool.submitCloudGatewayRequest({
      operation: mockForm.operation,
      accountId: mockForm.accountId,
      target: {
        channelUserId: mockForm.channelUserId.trim()
      },
      message: {
        type: mockForm.messageType,
        content
      },
      overrides: {
        eventId: mockForm.eventId.trim() || null,
        channelMessageId: mockForm.channelMessageId.trim() || null,
        clientTimestamp: mockForm.clientTimestamp
      }
    })
    mockResult.value = res.data?.data || null
    ElMessage.success('测试消息已提交')
    if (mockResult.value?.eventId) pollGatewayEvent(mockResult.value.eventId, 0)
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message)
  } finally {
    mockSubmitting.value = false
  }
}

async function pollGatewayEvent(eventId, attempt) {
  try {
    const res = await adminApi.testTool.getCloudGatewayEvent(eventId)
    mockResult.value = { ...mockResult.value, ...(res.data?.data || {}) }
    if (['processed', 'duplicate', 'rejected', 'dead_letter'].includes(mockResult.value?.status)) return
  } catch (error) {
    if (attempt >= 20) {
      ElMessage.error(error.response?.data?.message || '查询云网关事件超时')
      return
    }
  }
  if (attempt < 20) eventPollTimer = setTimeout(() => pollGatewayEvent(eventId, attempt + 1), 1000)
}

async function copyEventId() {
  if (!mockResult.value?.eventId) return
  await navigator.clipboard.writeText(mockResult.value.eventId)
  ElMessage.success('eventId 已复制')
}

async function openMockConversation() {
  const conversationId = mockResult.value?.ackResult?.conversationId
  if (!conversationId) return
  searchType.value = 'uuid'
  searchInput.value = conversationId
  currentConvId.value = conversationId
  hasSearched.value = true
  await loadConversation(conversationId)
}

function gatewayEventTagType(status) {
  if (status === 'processed' || status === 'duplicate') return 'success'
  if (status === 'dead_letter' || status === 'rejected') return 'danger'
  return 'warning'
}

function credentialSourceLabel(source) {
  return {
    mock_environment: 'Mock 环境变量',
    environment: '环境变量',
    configured_file: '指定文件',
    local_gateway_file: '自动读取',
    configured_file_error: '文件异常',
    local_gateway_file_missing: '文件未找到',
    unconfigured: '未配置'
  }[source] || '未配置'
}

function credentialSourceTip(source) {
  return {
    mock_environment: 'Rag 后端使用 CLOUD_GATEWAY_MOCK_TOKEN；浏览器不会获得 token 明文',
    environment: 'Rag 后端使用 CLOUD_GATEWAY_AUTH_TOKEN；浏览器不会获得 token 明文',
    configured_file: 'Rag 后端从 CLOUD_GATEWAY_AUTH_TOKEN_FILE 指定文件读取凭据',
    local_gateway_file: 'Rag 后端自动读取 wehook/data/gateway-auth-token.txt；浏览器不会获得 token 明文',
    configured_file_error: '指定的凭据文件无法读取或内容无效',
    local_gateway_file_missing: '尚未找到网关自动生成的本地凭据文件',
    unconfigured: '当前没有可用的云网关鉴权凭据'
  }[source] || '当前没有可用的云网关鉴权凭据'
}

function storeDriverLabel(driver) {
  return driver === 'mysql' ? 'MySQL' : driver === 'file' ? '本地文件' : String(driver || '未知')
}

function storeDriverTip(driver) {
  if (driver === 'mysql') return '事件、ACK、重试和死信持久化到 MySQL，适合共享存储'
  if (driver === 'file') return '事件持久化到本地 JSON 文件，仅适合本地单进程 Mock；生产应使用 MySQL'
  return `当前 Event Store 驱动：${driver || '未知'}`
}

onMounted(() => loadGatewayStatus())
onBeforeUnmount(() => clearTimeout(eventPollTimer))

// ========== 搜索 ==========
async function handleSearch() {
  const input = searchInput.value.trim()
  if (!input) {
    ElMessage.warning('请输入会话 UUID 或用户 ID')
    return
  }

  // 保存到搜索历史
  addToHistory(input)

  searchLoading.value = true
  hasSearched.value = true
  searchResults.value = []
  convData.value = null

  try {
    if (searchType.value === 'uuid') {
      // 直接按 UUID 查找
      currentConvId.value = input
      await loadConversation(input)
    } else {
      // 按 user_id 查找
      const res = await adminApi.testTool.findByUserId(input)
      if (res.data?.success && res.data.data?.length > 0) {
        searchResults.value = res.data.data
      } else {
        ElMessage.info('未找到匹配的会话')
      }
    }
  } catch (err) {
    ElMessage.error('查找失败: ' + (err.response?.data?.message || err.message))
  } finally {
    searchLoading.value = false
  }
}

// ========== 选择会话（从搜索结果列表） ==========
async function selectConversation(row) {
  currentConvId.value = row.id
  searchResults.value = []
  await loadConversation(row.id)
}

// ========== 加载会话详情 ==========
async function loadConversation(id) {
  try {
    const res = await adminApi.testTool.getConversation(id)
    if (res.data?.success) {
      convData.value = res.data.data
      // 同步当前池状态到表单
      poolForm.poolType = convData.value.conversation.pool_type || ''
      poolForm.convStatus = convData.value.conversation.conv_status || ''
    }
  } catch (err) {
    if (err.response?.status === 404) {
      convData.value = null
      ElMessage.warning('会话不存在')
    } else {
      ElMessage.error('加载失败: ' + (err.response?.data?.message || err.message))
    }
  }
}

// ========== 确认操作 ==========
async function confirmAction(action) {
  const id = currentConvId.value
  if (!id) return

  const actionMap = {
    resetToNew: {
      title: '重置为新客户',
      msg: '将把会话重置为新客户状态（pool_type=ai_self, conv_status=ai_serving），清除认领信息和未读数。消息不会被删除。',
      type: 'warning',
      fn: () => adminApi.testTool.resetToNew(id)
    },
    clearMessages: {
      title: '清除所有消息',
      msg: '将删除该会话的所有消息记录（plat_messages），此操作不可恢复！',
      type: 'error',
      fn: () => adminApi.testTool.clearMessages(id)
    },
    clearPoolLogs: {
      title: '清除池操作日志',
      msg: '将删除该会话的所有池操作日志（conversation_pool_logs），此操作不可恢复！',
      type: 'error',
      fn: () => adminApi.testTool.clearPoolLogs(id)
    },
    clearAiLogs: {
      title: '清除AI回复日志',
      msg: '将删除该会话的所有 AI 回复日志（ai_reply_logs），此操作不可恢复！',
      type: 'error',
      fn: () => adminApi.testTool.clearAiLogs(id)
    },
    deleteConversation: {
      title: '彻底删除会话',
      msg: '将彻底删除该会话及其所有消息、池操作日志、AI回复日志！此操作完全不可恢复！',
      type: 'error',
      fn: async () => {
        const res = await adminApi.testTool.deleteConversation(id)
        convData.value = null
        currentConvId.value = ''
        searchInput.value = ''
        return res
      }
    }
  }

  const config = actionMap[action]
  if (!config) return

  try {
    await ElMessageBox.confirm(config.msg, config.title, {
      confirmButtonText: '确认执行',
      cancelButtonText: '取消',
      type: config.type
    })

    const res = await config.fn()
    if (res.data?.success) {
      ElMessage.success(config.title + '成功')
      // 重新加载会话状态（除非已删除）
      if (action !== 'deleteConversation') {
        await loadConversation(id)
      }
    }
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(config.title + '失败: ' + (err.response?.data?.message || err.message))
    }
  }
}

// ========== 手动设置池 ==========
async function handleSetPool() {
  const id = currentConvId.value
  if (!id) return

  if (!poolForm.poolType && !poolForm.convStatus) {
    ElMessage.warning('请至少选择一项要修改的值')
    return
  }

  poolLoading.value = true
  try {
    const res = await adminApi.testTool.setPool(id, {
      poolType: poolForm.poolType || undefined,
      convStatus: poolForm.convStatus || undefined
    })
    if (res.data?.success) {
      ElMessage.success('池设置已更新')
      await loadConversation(id)
    }
  } catch (err) {
    ElMessage.error('设置失败: ' + (err.response?.data?.message || err.message))
  } finally {
    poolLoading.value = false
  }
}

// ========== 辅助函数 ==========
function poolTagType(pool) {
  const map = { ai_self: '', pending_human: 'warning', public: 'info', private: 'success', long_term: 'danger' }
  return map[pool] || 'info'
}

function statusTagType(status) {
  const map = { ai_serving: '', pending_claim: 'warning', handling: 'success', following: 'info', archived: 'danger' }
  return map[status] || 'info'
}

function replyByTagType(by) {
  const map = { ai: 'warning', customer: 'success', agent: 'primary' }
  return map[by] || 'info'
}

function senderTagType(type) {
  const map = { customer: 'success', agent: 'primary', ai: 'warning', system: 'info' }
  return map[type] || 'info'
}

function logActionType(action) {
  if (action?.includes('transfer') || action?.includes('archive')) return 'danger'
  if (action?.includes('claim')) return 'success'
  if (action?.includes('reset') || action?.includes('manual')) return 'warning'
  return 'primary'
}

function formatTime(ts) {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ts)
  }
}

function extractText(content) {
  if (!content) return '(空)'
  try {
    const obj = typeof content === 'string' ? JSON.parse(content) : content
    return obj.text || obj.content || JSON.stringify(obj).substring(0, 200)
  } catch {
    return String(content).substring(0, 200)
  }
}
</script>

<style scoped lang="scss">
.test-tool {
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.gateway-header {
  justify-content: space-between;
}

.gateway-title,
.gateway-status,
.gateway-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gateway-status {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-tag :deep(.el-tag__content) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-label {
  font-weight: 500;
}

.status-value {
  font-weight: 700;
}

.status-refresh {
  width: 28px;
  height: 28px;
  padding: 0;
}

.gateway-error {
  margin-bottom: 14px;
}

.gateway-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}

.gateway-form-grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.gateway-account-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  gap: 8px;
  width: 100%;
}

.gateway-result {
  margin-top: 16px;
}

.gateway-advanced {
  margin-bottom: 16px;
}

.json-input :deep(textarea) {
  font-family: Consolas, monospace;
  font-size: 13px;
}

.mono {
  font-family: Consolas, monospace;
  word-break: break-all;
}

.search-area {
  display: flex;
  gap: 12px;
  align-items: center;
}

.search-results {
  margin-top: 16px;

  .results-title {
    margin-bottom: 8px;
    font-size: 13px;
    color: #909399;
  }
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px 24px;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 8px;

  .info-label {
    color: #909399;
    font-size: 13px;
    white-space: nowrap;
    min-width: 70px;
  }

  .info-value {
    font-size: 13px;
    word-break: break-all;
  }
}

.stats-grid {
  display: flex;
  gap: 16px;
}

.stat-box {
  flex: 1;
  text-align: center;
  padding: 16px;
  border-radius: 8px;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;

  .stat-num {
    font-size: 28px;
    font-weight: 700;
    color: #303133;
    line-height: 1.2;
  }

  .stat-label {
    font-size: 12px;
    color: #909399;
    margin-top: 4px;
  }

  &.stat-customer .stat-num { color: #67c23a; }
  &.stat-ai .stat-num { color: #e6a23c; }
  &.stat-agent .stat-num { color: #409eff; }
}

.action-section {
  .section-title {
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 12px;
    color: #303133;
  }
}

.action-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.pool-setter {
  display: flex;
  gap: 10px;
  align-items: center;
}

.config-tip {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}

.msg-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg-item {
  padding: 10px;
  background: #f5f7fa;
  border-radius: 6px;
  border: 1px solid #ebeef5;

  .msg-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;

    .msg-type {
      font-size: 11px;
      color: #c0c4cc;
    }

    .msg-time {
      font-size: 11px;
      color: #c0c4cc;
      margin-left: auto;
    }
  }

  .msg-content {
    font-size: 13px;
    color: #606266;
    word-break: break-word;
  }
}

.log-entry {
  font-size: 13px;

  .log-flow {
    margin-left: 8px;
    color: #409eff;
  }

  .log-operator {
    margin-left: 8px;
    color: #909399;
    font-size: 12px;
  }

  .log-reason {
    margin-top: 4px;
    color: #606266;
    font-size: 12px;
  }
}

.empty-card {
  text-align: center;
}

@media (max-width: 720px) {
  .gateway-header {
    align-items: flex-start;
    gap: 10px;
    flex-direction: column;
  }

  .gateway-status {
    justify-content: flex-start;
  }

  .gateway-form-grid {
    grid-template-columns: 1fr;
    gap: 0;
  }
}

// 搜索历史下拉项样式（popper 挂载到 body，不在 scoped 范围内）
.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;

  .history-value {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .history-delete-btn {
    flex-shrink: 0;
    margin-left: 8px;
    opacity: 0;
    transition: opacity 0.2s;
    color: #909399;

    &:hover {
      color: #f56c6c;
    }
  }

  &:hover .history-delete-btn {
    opacity: 1;
  }
}
</style>

<style>
.search-history-popper {
  max-width: 420px !important;
}

.search-history-popper .history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.search-history-popper .history-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-history-popper .history-delete-btn {
  flex-shrink: 0;
  margin-left: 8px;
  opacity: 0;
  transition: opacity 0.2s;
  color: #909399;
}

.search-history-popper .history-delete-btn:hover {
  color: #f56c6c;
}

.search-history-popper .history-item:hover .history-delete-btn {
  opacity: 1;
}
</style>
