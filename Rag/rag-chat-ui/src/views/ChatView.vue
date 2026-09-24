<template>
  <div class="chat-page">
    <!-- 左侧会话列表 -->
    <div class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <span v-if="!sidebarCollapsed">会话列表</span>
        <el-button
          type="text"
          :icon="sidebarCollapsed ? Expand : Fold"
          @click="toggleSidebar"
          class="toggle-btn"
        />
      </div>
      <div class="sidebar-content" v-if="!sidebarCollapsed">
        <div class="new-session-btn" @click="createNewSession">
          <el-icon><Plus /></el-icon>
          <span>新建会话</span>
        </div>
        <div class="session-list">
          <div
            v-for="session in sessions"
            :key="session.threadId"
            class="session-item"
            :class="{ active: session.threadId === threadId }"
            @click="switchSession(session)"
          >
            <div class="session-title">{{ session.title || '新会话' }}</div>
            <div class="session-time">{{ formatTime(session.createdAt) }}</div>
            <el-button
              type="text"
              :icon="Delete"
              class="delete-btn"
              @click.stop="deleteSession(session.threadId)"
            />
          </div>
          <div v-if="sessions.length === 0" class="empty-sessions">
            暂无会话记录
          </div>
        </div>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="main-content" :class="{ expanded: sidebarCollapsed }">
      <!-- 用户信息栏 -->
      <div class="user-bar">
        <div class="user-info" v-if="userStore.isLoggedIn">
          <el-avatar :size="32" class="avatar">{{ userStore.user?.username?.charAt(0)?.toUpperCase() }}</el-avatar>
          <span class="username">{{ userStore.user?.username }}</span>
          <el-button type="danger" size="small" @click="handleLogout">退出</el-button>
        </div>
        <el-button v-else type="primary" size="small" @click="showLoginDialog = true">登录</el-button>
      </div>

      <!-- 消息列表 -->
      <div class="message-container" ref="messageContainer">
        <div class="message-list">
          <!-- 使用 computed 过滤后的消息列表 -->
          <div v-for="msg in displayMessages" :key="msg.id" class="message-item" :class="msg.type">
            <div class="message-avatar" v-if="msg.type === 'ai'">
              <el-icon><Service /></el-icon>
            </div>
            <div class="message-content">
              <!-- AI 消息支持 Markdown 渲染 -->
              <div v-if="msg.type === 'ai'" class="ai-content" v-html="renderMarkdown(msg.content)"></div>
              <!-- 用户消息普通显示 -->
              <div v-else>{{ msg.content }}</div>
            </div>
          </div>
          <!-- 加载中提示 -->
          <div v-if="isLoading" class="loading-indicator">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>正在思考中...</span>
          </div>
          <!-- 兜底提示 -->
          <div v-if="displayMessages.length === 0 && !isLoading" class="empty-tip">
            <span>开始对话吧，试试发送一条消息</span>
          </div>
        </div>
      </div>

      <!-- 消息输入区 -->
      <div class="input-area">
        <div class="input-box" @click="focusInput">
          <div class="input-top">
            <div class="suggestions">
              <div class="suggestion-pill" @click.stop="handleSuggestion(suggestion)" v-for="suggestion in suggestions.slice(0, 2)" :key="suggestion">
                {{ suggestion }}
              </div>
            </div>
          </div>
          <div class="input-row">
            <!-- 隐藏的文件上传 input -->
            <input
              ref="fileInputRef"
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md"
              style="display: none"
              @change="handleFileSelect"
            />
            <!-- 附件预览 -->
            <div v-if="currentAttachment" class="attachment-preview">
              <div class="attachment-info">
                <el-icon><Paperclip /></el-icon>
                <span class="attachment-name">{{ currentAttachment.fileName }}</span>
                <span class="attachment-size">({{ currentAttachment.stats?.totalLength || 0 }} 字符)</span>
              </div>
              <el-icon class="remove-attachment" @click="removeAttachment"><Delete /></el-icon>
            </div>
            <textarea
              ref="messageInputRef"
              v-model="inputMessage"
              placeholder="输入消息..."
              :disabled="isLoading"
              class="message-input"
              @keyup.enter="handleSend"
              rows="1"
            ></textarea>
            <div class="input-actions">
              <el-icon class="action-icon" :class="{ uploading: isUploadingAttachment }" @click="triggerFileUpload">
                <Paperclip v-if="!isUploadingAttachment" />
                <Loading v-else class="is-loading" />
              </el-icon>
              <div class="send-btn" :class="{ disabled: isLoading || !inputMessage.trim() }" @click="handleSend">
                <el-icon v-if="!isLoading"><Promotion /></el-icon>
                <el-icon v-else class="is-loading"><Loading /></el-icon>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 登录注册弹窗 -->
    <el-dialog
      v-model="showLoginDialog"
      :title="isLogin ? '用户登录' : '用户注册'"
      width="420px"
      :close-on-click-modal="false"
      class="login-dialog"
      center
    >
      <div class="dialog-content">
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-width="0"
        >
          <el-form-item prop="username">
            <el-input
              v-model="form.username"
              placeholder="请输入用户名"
              prefix-icon="User"
              size="large"
              clearable
            />
          </el-form-item>

          <el-form-item prop="password">
            <el-input
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              prefix-icon="Lock"
              size="large"
              show-password
              clearable
            />
          </el-form-item>

          <el-form-item v-if="!isLogin" prop="email">
            <el-input
              v-model="form.email"
              placeholder="请输入邮箱(选填)"
              prefix-icon="Message"
              size="large"
              clearable
            />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button class="cancel-btn" @click="handleCancel">取消</el-button>
          <el-button type="primary" class="submit-btn" :loading="loading" @click="handleSubmit">
            {{ isLogin ? '登录' : '注册' }}
          </el-button>
        </div>
        <div class="switch-mode">
          <span @click="switchMode">
            {{ isLogin ? '没有账号？去注册' : '已有账号？去登录' }}
          </span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Loading, Promotion, Plus, Delete, Fold, Expand, Paperclip, Service } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { chatApi } from '@/api/chat'
import { marked } from 'marked'

const userStore = useUserStore()

// 会话列表
const sidebarCollapsed = ref(false)
const sessions = ref([])
const currentSessionMessages = ref({})

// 当前会话
const messages = computed(() => {
  if (!threadId.value) return []
  return currentSessionMessages.value[threadId.value] || []
})

// 过滤和格式化消息用于显示
const displayMessages = computed(() => {
  return messages.value
    .filter(msg => {
      // 过滤掉包含"参考资料"的系统注入消息
      if ((msg.type === 'human' || msg.type === 'user') && msg.content?.startsWith?.('【参考资料】')) {
        return false
      }
      return true
    })
    .map(msg => {
      // 统一消息类型：human -> user, ai -> ai
      let normalizedType = msg.type
      if (msg.type === 'human') normalizedType = 'user'

      // 处理 AI 消息的 content 是数组的情况
      if (msg.type === 'ai' && Array.isArray(msg.content)) {
        const textContent = msg.content.find(c => c.type === 'text')?.text || ''
        return { ...msg, type: normalizedType, content: textContent }
      }

      return { ...msg, type: normalizedType }
    })
})

// Markdown 渲染配置
marked.setOptions({
  breaks: true,  // 支持换行
  gfm: true      // 支持 GitHub Flavored Markdown
})

const renderMarkdown = (text) => {
  if (!text) return ''
  return marked.parse(text)
}
const inputMessage = ref('')
const isLoading = ref(false)
const threadId = ref('')
const messageContainer = ref(null)
const messageInputRef = ref(null)

// 附件相关
const fileInputRef = ref(null)
const currentAttachment = ref(null)  // 当前已上传的附件 { fileName, textContent, chunks }
const isUploadingAttachment = ref(false)

// 消息 ID
let messageId = 0

// 建议问题
const suggestions = [
  '如何上传文档到知识库？',
  'RAG技术是什么？',
  '如何配置分块模板？',
  '智能客服能做什么？'
]

// 登录弹窗相关
const showLoginDialog = ref(false)
const isLogin = ref(true)
const loading = ref(false)
const formRef = ref(null)

const form = reactive({
  username: '',
  password: '',
  email: ''
})

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度为 3-20 个字符', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度为 6-20 个字符', trigger: 'blur' }
  ],
  email: [
    { type: 'email', message: '请输入正确的邮箱地址', trigger: 'blur' }
  ]
}

// 切换侧边栏
const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// 格式化时间
const formatTime = (time) => {
  if (!time) return ''
  const date = new Date(time)
  const now = new Date()
  const diff = now - date
  
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return date.toLocaleDateString()
}

// 创建新会话
const createNewSession = async () => {
  try {
    const res = await chatApi.createThread(userStore.user?.id || 'anonymous')
    // 后端返回格式: { success: true, data: { thread_id: ... } }
    const newThreadId = res.data?.data?.thread_id || res.data?.thread_id

    if (!newThreadId) {
      console.error('创建会话返回格式错误:', res.data)
      ElMessage.error('创建会话失败：返回数据格式错误')
      return
    }

    // 添加到会话列表
    sessions.value.unshift({
      threadId: newThreadId,
      title: '新会话',
      createdAt: new Date().toISOString(),
      messages: []
    })

    // 切换到新会话
    threadId.value = newThreadId
    currentSessionMessages.value[newThreadId] = []

    ElMessage.success('新建会话成功')
  } catch (error) {
    console.error('创建会话失败:', error)
    ElMessage.error(error?.message || '创建会话失败')
  }
}

// 切换会话
const switchSession = (session) => {
  threadId.value = session.threadId
  // 加载该会话的消息
  if (!currentSessionMessages.value[session.threadId]) {
    currentSessionMessages.value[session.threadId] = session.messages || []
  }
  scrollToBottom()
}

// 删除会话
const deleteSession = async (targetThreadId) => {
  try {
    await ElMessageBox.confirm('确定删除该会话？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })

    // 调用后端接口删除
    await chatApi.deleteThread(targetThreadId)

    // 从列表中移除
    sessions.value = sessions.value.filter(s => s.threadId !== targetThreadId)
    delete currentSessionMessages.value[targetThreadId]

    // 如果删除的是当前会话，切换到第一个或创建新的
    if (threadId.value === targetThreadId) {
      if (sessions.value.length > 0) {
        switchSession(sessions.value[0])
      } else {
        threadId.value = ''
        await createNewSession()
      }
    }

    ElMessage.success('删除成功')
  } catch (error) {
    // 用户取消不报错
    if (error !== 'cancel') {
      console.error('删除会话失败:', error)
      ElMessage.error(error?.message || '删除会话失败')
    }
  }
}

// 从后端加载会话列表
const loadSessions = async () => {
  try {
    const res = await chatApi.getThreads(userStore.user?.id || 'anonymous')
    if (res.data?.success && res.data?.data) {
      sessions.value = res.data.data.map(thread => ({
        threadId: thread.thread_id,
        title: thread.title,
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        messages: thread.messages || []
      }))
      // 加载所有会话的消息到内存
      sessions.value.forEach(session => {
        currentSessionMessages.value[session.threadId] = session.messages || []
      })
    } else {
      // 后端返回格式不符合预期
      console.error('后端返回格式错误:', res.data)
      ElMessage.error(res.data?.message || '获取会话列表失败')
    }
  } catch (error) {
    console.error('加载会话列表失败:', error)
    // 显示后端返回的具体错误信息
    ElMessage.error(error?.message || '加载会话列表失败')
  }
}

// 页面加载时检测登录状态并初始化会话
onMounted(async () => {
  if (!userStore.isLoggedIn) {
    showLoginDialog.value = true
    return
  }

  // 从后端加载会话列表
  await loadSessions()

  // 如果没有会话，创建一个新会话
  if (sessions.value.length === 0) {
    await createNewSession()
  } else {
    // 切换到最近的会话
    switchSession(sessions.value[0])
  }
})

// ========== 附件上传相关函数 ==========

// 触发文件上传
const triggerFileUpload = () => {
  if (isUploadingAttachment.value) return
  if (fileInputRef.value) {
    fileInputRef.value.click()
  }
}

// 处理文件选择
const handleFileSelect = async (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  // 验证文件类型
  const allowedTypes = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md']
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (!allowedTypes.includes(ext)) {
    ElMessage.warning('不支持的文件类型，仅支持 PDF、Word、Excel、PPT、TXT、Markdown')
    return
  }

  // 验证文件大小
  if (file.size > 50 * 1024 * 1024) {
    ElMessage.warning('文件大小不能超过 50MB')
    return
  }

  isUploadingAttachment.value = true

  try {
    // 调用上传解析接口
    const res = await chatApi.uploadAttachment(file)
    if (res.data?.success) {
      currentAttachment.value = res.data.data
      ElMessage.success(`附件 "${file.name}" 已解析成功`)
    } else {
      throw new Error(res.data?.message || '上传解析失败')
    }
  } catch (error) {
    console.error('附件上传失败:', error)
    ElMessage.error(error?.message || '附件上传解析失败')
  } finally {
    isUploadingAttachment.value = false
    // 清空 input，允许再次选择同一文件
    if (fileInputRef.value) {
      fileInputRef.value.value = ''
    }
  }
}

// 移除附件
const removeAttachment = () => {
  currentAttachment.value = null
}

// ========== 发送消息函数 ==========

// 发送消息
const handleSend = async () => {
  if (!inputMessage.value.trim() || isLoading.value) return
  if (!threadId.value) {
    ElMessage.warning('请先创建会话')
    return
  }

  isLoading.value = true

  // 添加用户消息（包含附件信息）
  const userMsgContent = currentAttachment.value
    ? `${inputMessage.value.trim()}\n\n📎 附件: ${currentAttachment.value.fileName}`
    : inputMessage.value.trim()

  const userMsg = {
    id: ++messageId,
    type: 'user',
    content: userMsgContent
  }

  // 确保消息数组存在
  if (!currentSessionMessages.value[threadId.value]) {
    currentSessionMessages.value[threadId.value] = []
  }
  currentSessionMessages.value[threadId.value].push(userMsg)

  const currentUserInput = inputMessage.value.trim()
  // 准备附件数据
  const attachmentDocs = currentAttachment.value ? [currentAttachment.value] : null
  inputMessage.value = ''
  currentAttachment.value = null  // 发送后清除附件

  // 更新会话标题（使用第一条消息）
  const session = sessions.value.find(s => s.threadId === threadId.value)
  if (session && (!session.title || session.title === '新会话')) {
    session.title = currentUserInput.slice(0, 20) + (currentUserInput.length > 20 ? '...' : '')
  }

  // 自动滚动到底
  scrollToBottom()

  try {
    // 发送消息(使用流式 API)
    const requestBody = {
      thread_id: threadId.value,
      input: { messages: [{ content: currentUserInput }] }
    }

    // 如果有附件，添加 attachmentDocs 参数
    if (attachmentDocs) {
      requestBody.attachmentDocs = attachmentDocs
    }

    const response = await fetch(`/api/langchain/runs/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify(requestBody)
    })

    // 处理 SSE 流式响应
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullResponse = ''
    let aiMsgId = null
    let currentEventType = ''  // 当前事件类型

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value)
      const lines = text.split('\n')

      for (const line of lines) {
        if (!line.trim()) continue

        // 解析事件类型
        if (line.startsWith('event: ')) {
          currentEventType = line.substring(7)
          if (currentEventType === 'run_completed') {
            isLoading.value = false
          }
          continue
        }

        // 解析 SSE 数据
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.substring(6)
            const data = JSON.parse(jsonStr)

            // 处理错误事件（标准格式：{ type: 'error', message: '...' }）
            if (data.type === 'error') {
              isLoading.value = false
              // 移除正在生成的 AI 消息（如果有）
              if (aiMsgId !== null) {
                const msgs = currentSessionMessages.value[threadId.value]
                const idx = msgs.findIndex(m => m.id === aiMsgId)
                if (idx !== -1) {
                  msgs.splice(idx, 1)
                }
              }
              // 抛出错误，显示具体错误信息
              throw new Error(data.message || '流式响应错误')
            }

            // 处理文本事件（标准格式：{ type: 'text', content: 'token' }）
            if (data.type === 'text' && data.content) {
              fullResponse += data.content

              // 更新或添加 AI 消息
              if (aiMsgId === null) {
                aiMsgId = ++messageId
                currentSessionMessages.value[threadId.value].push({
                  id: aiMsgId,
                  type: 'ai',
                  content: fullResponse
                })
              } else {
                const msgs = currentSessionMessages.value[threadId.value]
                const aiMsg = msgs.find(m => m.id === aiMsgId)
                if (aiMsg) {
                  aiMsg.content = fullResponse
                }
              }

              scrollToBottom()
            }

            // 可选：处理工具调用事件（显示工具状态）
            if (data.type === 'tool_start') {
              console.log('工具调用开始:', data.tool)
              // 可以在 UI 中显示 "正在调用XX工具..."
            }

            if (data.type === 'tool_result') {
              console.log('工具调用结果:', data.tool, data.result)
              // 可以在 UI 中显示工具返回结果
            }
          } catch (e) {
            // 如果是我们主动抛出的错误，直接抛出
            if (e.message && e.message !== '解析SSE数据失败') {
              throw e
            }
            console.error('解析SSE数据失败:', e)
          }
        }
      }
    }

    isLoading.value = false
  } catch (error) {
    console.error('发送消息失败:', error)
    // 显示具体的错误信息
    const errorMsg = error?.message || '发送消息失败'
    ElMessage.error(errorMsg)
    isLoading.value = false
  }
}

// 点击建议问题
const handleSuggestion = (suggestion) => {
  inputMessage.value = suggestion
  handleSend()
}

// 聚焦输入框
const focusInput = async () => {
  await nextTick()
  if (messageInputRef.value) {
    messageInputRef.value.focus()
  }
}

// 滚动到底部
const scrollToBottom = async () => {
  await nextTick()
  if (messageContainer.value) {
    messageContainer.value.scrollTop = messageContainer.value.scrollHeight
  }
}

// 退出登录
const handleLogout = () => {
  userStore.logout()
  ElMessage.success('已退出登录')
  showLoginDialog.value = true
  threadId.value = ''
  sessions.value = []
  currentSessionMessages.value = {}
}

// 登录弹窗方法
const switchMode = () => {
  isLogin.value = !isLogin.value
  formRef.value?.resetFields()
}

const handleCancel = () => {
  if (!userStore.isLoggedIn) {
    ElMessage.warning('请先登录后再使用')
    return
  }
  showLoginDialog.value = false
}

const handleSubmit = async () => {
  try {
    await formRef.value.validate()
    loading.value = true

    let result
    if (isLogin.value) {
      result = await userStore.login(form.username, form.password)
    } else {
      result = await userStore.register(form.username, form.password, form.email)
    }

    if (result.success) {
      ElMessage.success(result.message)
      showLoginDialog.value = false
      formRef.value.resetFields()

      // 登录成功后加载会话列表
      await loadSessions()
      if (sessions.value.length === 0) {
        await createNewSession()
      } else {
        switchSession(sessions.value[0])
      }
    } else {
      ElMessage.error(result.message)
    }
  } catch (error) {
    if (error !== false) {
      ElMessage.error(isLogin.value ? '登录失败' : '注册失败')
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="scss">
.chat-page {
  width: 100%;
  height: 100vh;
  position: relative;
  display: flex;
}

// 左侧会话列表
.sidebar {
  width: 280px;
  height: 100vh;
  background: #f9fafb;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  transition: width 0.3s;

  &.collapsed {
    width: 48px;
  }

  .sidebar-header {
    height: 56px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #e5e7eb;

    span {
      font-weight: 500;
      color: #374151;
    }

    .toggle-btn {
      padding: 8px;
      color: #6b7280;

      &:hover {
        background: #f3f4f6;
        border-radius: 6px;
      }
    }
  }

  .sidebar-content {
    flex: 1;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;

    .new-session-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 16px;
      background: #1677ff;
      color: #fff;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-size: 14px;
      box-shadow: 0 2px 6px rgba(22, 119, 255, 0.15);

      &:hover {
        background: #4096ff;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(22, 119, 255, 0.25);
      }

      &:active {
        transform: translateY(0);
      }

      .el-icon {
        font-size: 16px;
      }
    }

    .session-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;

      .session-item {
        padding: 12px 14px;
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.15s ease;
        position: relative;
        user-select: none;
        -webkit-user-select: none;
        // background: #fff;

        // 未激活状态 - 灰色字体
        .session-title {
          font-size: 14px;
          color: #6b7280;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          margin-bottom: 6px;
        }

        .session-time {
          font-size: 12px;
          color: #9ca3af;
        }

        .delete-btn {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          padding: 4px;
          color: #9ca3af;
          opacity: 0;
          transition: opacity 0.15s;

          // &:hover {
          //   color: #ef4444;
          //   background: #fef2f2;
          //   border-radius: 4px;
          // }
        }

        // hover 效果
        // &:hover:not(.active) {
        //   background: #fff;
        //   box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);

        //   .session-title {
        //     color: #374151;
        //   }

        //   .delete-btn {
        //     opacity: 1;
        //   }
        // }

        // 激活状态 - 淡蓝色背景，蓝色字体
        &.active {
          background: #eff6ff;
          box-shadow: 0 4px 12px rgba(29, 78, 216, 0.1);

          .session-title {
            color: #1d4ed8;
            font-weight: 500;
          }

          .session-time {
            color: #3b82f6;
          }

          .delete-btn {
            color: #1d4ed8;
            opacity: 0;
          }

          &:hover .delete-btn {
            opacity: 1;
          }
        }
      }

      .empty-sessions {
        text-align: center;
        color: #9ca3af;
        padding: 40px 0;
        font-size: 14px;
      }
    }
  }
}

// 主内容区
.main-content {
  flex: 1;
  height: 100vh;
  display: flex;
  flex-direction: column;
  transition: all 0.3s;

  .user-bar {
    position: absolute;
    top: 16px;
    right: 24px;
    z-index: 100;

    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
      background: rgba(255, 255, 255, 0.9);
      padding: 8px 16px;
      border-radius: 24px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);

      .avatar {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: #fff;
        font-weight: 500;
      }

      .username {
        font-size: 14px;
        color: #333;
      }
    }
  }

  .message-container {
    flex: 1;
    overflow-y: auto;
    padding: 80px 20px 20px;
    background: transparent;

    .message-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-width: 800px;
      margin: 0 auto;

      .message-item {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        max-width: 85%;

        &.user {
          align-self: flex-end;
          flex-direction: row-reverse;

          .message-content {
            padding: 12px 16px;
            border-radius: 12px 12px 4px 12px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            line-height: 1.6;
            word-break: break-word;
          }
        }

        &.ai {
          align-self: flex-start;

          .message-avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: linear-gradient(135deg, #1677ff 0%, #4096ff 100%);
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .message-content {
            flex: 1;
            min-width: 0;
          }

          .ai-content {
            padding: 16px 20px;
            border-radius: 12px 4px 12px 12px;
            background: #fff;
            color: #333;
            border: 1px solid #e8e8e8;
            line-height: 1.7;
            word-break: break-word;

            // Markdown 样式
            p {
              margin: 0 0 12px 0;
              &:last-child { margin-bottom: 0; }
            }

            strong, b {
              font-weight: 600;
              color: #1a1a1a;
            }

            code {
              background: #f5f5f5;
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 14px;
              font-family: 'Consolas', 'Monaco', monospace;
            }

            pre {
              background: #f5f5f5;
              padding: 12px;
              border-radius: 8px;
              overflow-x: auto;
              margin: 12px 0;

              code {
                background: none;
                padding: 0;
              }
            }

            ul, ol {
              margin: 12px 0;
              padding-left: 24px;

              li {
                margin: 6px 0;
              }
            }

            h1, h2, h3, h4 {
              margin: 16px 0 8px 0;
              font-weight: 600;
            }

            a {
              color: #1677ff;
              text-decoration: none;
              &:hover { text-decoration: underline; }
            }
          }
        }
      }
    }

    .loading-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px;
      color: #999;
      max-width: 800px;
      margin: 0 auto;
    }

    .empty-tip {
      text-align: center;
      padding: 40px;
      color: #999;
      max-width: 800px;
      margin: 0 auto;
    }
  }

  .input-area {
    padding: 16px 20px 24px;
    background: transparent;

    .input-box {
        max-width: 800px;
        margin: 0 auto;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 16px;
        padding: 12px 16px;
        transition: all 0.2s;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        cursor: default;
        user-select: none;
        -webkit-user-select: none;

        &:focus-within {
          border-color: #1677ff;
          box-shadow: 0 4px 16px rgba(22, 119, 255, 0.15);
        }

        .input-top {
          .suggestions {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;

            .suggestion-pill {
              padding: 4px 12px;
              background: #f0f5ff;
              color: #1677ff;
              border-radius: 20px;
              font-size: 12px;
              cursor: pointer;
              transition: all 0.15s;

              &:hover {
                background: #e6f4ff;
              }
            }
          }
        }

        .input-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 36px;
          cursor: default;
          user-select: none;
          -webkit-user-select: none;

        // 附件预览样式
        .attachment-preview {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          background: #f0f9ff;
          border: 1px solid #bae6fd;
          border-radius: 6px;
          margin-bottom: 4px;

          .attachment-info {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            color: #0369a1;

            .el-icon {
              font-size: 14px;
            }

            .attachment-name {
              font-weight: 500;
              max-width: 150px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .attachment-size {
              color: #6b7280;
              font-size: 12px;
            }
          }

          .remove-attachment {
            font-size: 14px;
            color: #ef4444;
            cursor: pointer;
            padding: 2px;
            border-radius: 4px;
            transition: background 0.15s;

            &:hover {
              background: #fee2e2;
            }
          }
        }

        .message-input {
          flex: 1;
          border: none !important;
          outline: none !important;
          background: transparent;
          resize: none;
          padding: 0;
          margin: 0;
          font-size: 14px;
          line-height: 1.5;
          min-height: 24px;
          max-height: 120px;
          font-family: inherit;
          cursor: text;

          &::placeholder {
            color: #9ca3af;
          }

          &:focus {
            outline: none !important;
            border: none !important;
          }

          &:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        }

        .input-actions {
          display: flex;
          align-items: center;
          gap: 8px;

          .action-icon {
            font-size: 18px;
            color: #6b7280;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: all 0.15s;

            &:hover {
              background: #f3f4f6;
              color: #374151;
            }

            &.uploading {
              color: #1677ff;
              cursor: not-allowed;
              animation: pulse 1.5s ease-in-out infinite;
            }
          }

          .send-btn {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #1677ff;
            border-radius: 50%;
            color: #fff;
            cursor: pointer;
            transition: all 0.15s;

            &:hover:not(.disabled) {
              background: #4096ff;
            }

            &.disabled {
              background: #e5e7eb;
              color: #9ca3af;
              cursor: not-allowed;
            }

            .is-loading {
              animation: rotate 1s linear infinite;
            }
          }
        }
      }
    }
  }
}

.login-dialog {
  .dialog-content {
    padding: 20px 10px 0;
  }

  .dialog-footer {
    display: flex;
    justify-content: center;
    gap: 16px;
    padding: 10px 0;

    .cancel-btn {
      min-width: 100px;
    }

    .submit-btn {
      min-width: 100px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: none;

      &:hover {
        background: linear-gradient(135deg, #5a6fd6 0%, #6a4192 100%);
      }
    }
  }

  .switch-mode {
    text-align: center;
    padding-top: 12px;
    border-top: 1px solid #eee;

    span {
      color: #667eea;
      cursor: pointer;
      font-size: 14px;

      &:hover {
        text-decoration: underline;
      }
    }
  }
}

// rotate 动画
@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

// pulse 动画（附件上传中）
@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>