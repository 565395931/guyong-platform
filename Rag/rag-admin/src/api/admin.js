import axios from 'axios'

const request = axios.create({
  baseURL: '/api',
  timeout: 60000 // 增加超时时间到60秒，因为上传文件可能需要更长时间
})

// 请求拦截器 - 添加 token
request.interceptors.request.use(
  config => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  error => {
    return Promise.reject(error)
  }
)

// 响应拦截器 - 处理认证错误
request.interceptors.response.use(
  response => {
    return response
  },
  error => {
    if (error.response?.status === 401) {
      // Token 过期或无效，跳转到登录页（避免整页刷新）
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (window.location.pathname !== '/login') {
        window.location.replace('/login')
      }
    }

    return Promise.reject(error)
  }
)

const appendKnowledgeMeta = (formData, knowledgeMeta = {}) => {
  if (knowledgeMeta.knowledgeScope) {
    formData.append('knowledgeScope', knowledgeMeta.knowledgeScope)
  }
  if (knowledgeMeta.knowledgeChannels) {
    formData.append('knowledgeChannels', JSON.stringify(knowledgeMeta.knowledgeChannels))
  }
}

export const adminApi = {
  // ========== 认证相关 ==========
  // 用户注册
  register(data) {
    return request.post('/auth/register', data)
  },

  // 用户登录
  login(data) {
    return request.post('/auth/login', data)
  },

  // 获取当前用户信息
  getCurrentUser() {
    return request.get('/auth/me')
  },

  // 修改密码
  changePassword(data) {
    return request.post('/auth/change-password', data)
  },

  // ========== 统计数据 ==========
  getStats() {
    return request.get('/admin/stats')
  },
  
  // 文档管理 - 获取阿里云百炼知识库文档列表
  getDocuments(params = {}) {
    return request.get('/knowledge/documents', { params })
  },
  
  // 获取文档详情
  getDocumentDetail(fileId) {
    return request.get('/knowledge/documents/detail', { params: { fileId } })
  },

  // 获取文档切片列表
  getDocumentChunks(fileId, pageNum = 1, pageSize = 10) {
    return request.get('/knowledge/documents/chunks', { params: { fileId, pageNum, pageSize } })
  },

  downloadDocument(row) {
    return request.get('/knowledge/documents/download', {
      params: {
        documentId: row.documentId,
        fileId: row.fileId || row.sourceFileId,
        fileName: row.fileName,
        size: row.size
      },
      responseType: 'blob',
      timeout: 300000
    })
  },

  deleteDocument(documentId) {
    return request.post('/knowledge/documents/delete', { documentId })
  },

  deleteDocuments(documentIds) {
    return request.post('/knowledge/documents/delete', { documentIds })
  },
  
  // ========== 阿里云知识库直接上传 ==========
  // 单文件直接上传到阿里云知识库
  uploadFile(file, knowledgeMeta = {}) {
    const formData = new FormData()
    formData.append('file', file)
    appendKnowledgeMeta(formData, knowledgeMeta)
    return request.post('/upload/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 300000 // 最长5分钟
    })
  },
  
  // 批量直接上传到阿里云知识库
  uploadFiles(files, knowledgeMeta = {}) {
    const formData = new FormData()
    files.forEach(file => {
      formData.append('files', file)
    })
    appendKnowledgeMeta(formData, knowledgeMeta)
    return request.post('/upload/upload-batch', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 600000 // 批量最长10分钟
    })
  },
  
  // ========== 本地解析 + 百炼上传（完整链路）==========
  // 单文件：本地解析 → 分块 → 向量化 → 上传百炼
  uploadToBailian(file, templateId, templateConfig, knowledgeMeta = {}) {
    const formData = new FormData()
    formData.append('file', file)
    appendKnowledgeMeta(formData, knowledgeMeta)
    if (templateId) {
      formData.append('templateId', templateId)
    }
    if (templateConfig) {
      formData.append('templateConfig', JSON.stringify(templateConfig))
    }
    return request.post('/local/upload-to-bailian', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 300000 // 完整链路最长5分钟
    })
  },
  
  // 批量：本地解析 → 分块 → 向量化 → 上传百炼
  uploadToBailianBatch(files, templateId, templateConfig, knowledgeMeta = {}) {
    const formData = new FormData()
    files.forEach(file => {
      formData.append('files', file)
    })
    appendKnowledgeMeta(formData, knowledgeMeta)
    if (templateId) {
      formData.append('templateId', templateId)
    }
    if (templateConfig) {
      formData.append('templateConfig', JSON.stringify(templateConfig))
    }
    return request.post('/local/upload-to-bailian-batch', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 600000 // 批量完整链路最长10分钟
    })
  },
  
  // ========== 可发送媒体文件管理 ==========
  getMediaFiles(params = {}) {
    return request.get('/v1/media-files', { params })
  },

  uploadMediaFile(file) {
    const formData = new FormData()
    formData.append('file', file)
    return request.post('/v1/media-files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 300000
    })
  },

  uploadMediaFiles(files) {
    const formData = new FormData()
    files.forEach(file => {
      formData.append('files', file)
    })
    return request.post('/v1/media-files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 600000
    })
  },

  updateMediaFile(id, data) {
    return request.put(`/v1/media-files/${id}`, data)
  },

  deleteMediaFile(id) {
    return request.delete(`/v1/media-files/${id}`)
  },

  // ========== 快捷指令管理 ==========
  getQuickReplies(params = {}) {
    return request.get('/v1/quick-replies', { params })
  },

  createQuickReply(data) {
    return request.post('/v1/quick-replies', data)
  },

  updateQuickReply(id, data) {
    return request.put(`/v1/quick-replies/${id}`, data)
  },

  updateQuickReplyStatus(id, isEnabled) {
    return request.patch(`/v1/quick-replies/${id}/status`, { isEnabled })
  },

  deleteQuickReply(id) {
    return request.delete(`/v1/quick-replies/${id}`)
  },

  // ========== 分块预览 + 确认上传（两步流程）==========
  // 预览分块（只解析，不上传）
  previewChunks(file, templateId, templateConfig, knowledgeMeta = {}) {
    const formData = new FormData()
    formData.append('file', file)
    appendKnowledgeMeta(formData, knowledgeMeta)
    if (templateId) {
      formData.append('templateId', templateId)
    }
    if (templateConfig) {
      formData.append('templateConfig', JSON.stringify(templateConfig))
    }
    return request.post('/local/preview-chunks', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 120000 // 预览最长2分钟
    })
  },
  
  // 确认上传（接收预览数据，上传到百炼）
  confirmUpload(chunks, fileName, waitForIndex = false, sourceArchiveId = null, knowledgeMeta = {}) {
    return request.post('/local/confirm-upload', {
      chunks,
      fileName,
      waitForIndex,
      sourceArchiveId,
      ...knowledgeMeta
    }, {
      timeout: 600000 // 上传最长10分钟
    })
  },
  
  // AI 推荐 QA 反馈列表
  getQAList(params = {}) {
    return request.get('/v1/qa-records', { params })
  },

  updateQARecord(id, data) {
    return request.patch(`/v1/qa-records/${id}`, data)
  },

  deleteQARecord(id) {
    return request.delete(`/v1/qa-records/${id}`)
  },
  
  // 坐席管理
  getUsers(params = {}) {
    return request.get('/admin/users', { params })
  },

  getSeatSkillTags() {
    return request.get('/admin/seat-skill-tags')
  },

  createSeatSkillTag(name) {
    return request.post('/admin/seat-skill-tags', { name })
  },

  deleteSeatSkillTag(id) {
    return request.delete(`/admin/seat-skill-tags/${id}`)
  },

  // 创建坐席（通过注册接口）
  createAgent(data) {
    return request.post('/auth/register', data)
  },

  // 更新坐席
  updateUser(id, data) {
    return request.post(`/admin/users/${id}/update`, data)
  },

  deleteUser(id) {
    return request.delete(`/admin/users/${id}`)
  },

  // ========== 坐席账号绑定 ==========

  // 绑定账号到坐席
  bindAccountToSeat(seatId, accountId) {
    return request.post('/v1/seat-bindings', { seat_id: seatId, account_id: accountId })
  },

  // 解绑账号
  unbindAccount(bindingId) {
    return request.delete(`/v1/seat-bindings/${bindingId}`)
  },

  // 查询坐席的绑定列表
  getSeatBindings(seatId, options = {}) {
    const params = { seat_id: seatId }
    if (options.sync) {
      params.sync = 1
    }
    return request.get('/v1/seat-bindings', { params })
  },

  // 查询可绑定的账号（未被其他坐席绑定）
  getAvailableAccounts(channel, options = {}) {
    const params = { channel }
    if (options.sync) {
      params.sync = 1
    }
    return request.get('/v1/seat-bindings/available', { params })
  },
  
  // 会话记录
  getSessions() {
    return request.get('/admin/sessions')
  },
  
  getSessionDetail(id) {
    return request.get(`/admin/sessions/${id}`)
  },
  
  deleteSession(id) {
    return request.delete(`/admin/sessions/${id}`)
  },
  
  // ========== 模板管理 ==========
  // 获取模板列表
  getTemplates(params = {}) {
    return request.get('/template/list', { params })
  },
  
  // 获取单个模板详情
  getTemplate(templateId) {
    return request.get(`/template/detail/${templateId}`)
  },
  
  // 获取默认模板
  getDefaultTemplate() {
    return request.get('/template/default')
  },
  
  // 新增模板
  createTemplate(data) {
    return request.post('/template/create', data)
  },
  
  // 编辑模板
  updateTemplate(templateId, data) {
    return request.post(`/template/update/${templateId}`, data)
  },
  
  // 删除模板
  deleteTemplate(templateId) {
    return request.post(`/template/delete/${templateId}`)
  },
  
  // 设置默认模板
  setDefaultTemplate(templateId) {
    return request.post(`/template/set-default/${templateId}`)
  },
  
  // 初始化模板表
  initTemplates() {
    return request.post('/template/init')
  },

  // ========== 会话池配置 ==========
  // 获取全部会话池配置
  getPoolConfig() {
    return request.get('/v1/conversations/pool-config')
  },

  // 更新某个会话池配置项
  updatePoolConfig(key, value) {
    return request.put(`/v1/conversations/pool-config/${key}`, { value })
  },

  // ========== 池操作日志 ==========
  // 获取池状态流转日志（带筛选）
  getPoolLogs(params = {}) {
    return request.get('/v1/conversations/pool-logs', { params })
  },

  getSystemLogFiles() {
    return request.get('/v1/system-logs/files')
  },

  getSystemLogs(params = {}) {
    return request.get('/v1/system-logs', { params })
  },

  // ========== AI 回复队列监控 ==========
  // 获取队列实时状态
  getQueueStats() {
    return request.get('/v1/conversations/queue-stats')
  },

  // 获取 AI 回复业务日志
  getAiReplyLogs(params = {}) {
    return request.get('/v1/conversations/ai-reply-logs', { params })
  },

  // ========== 测试工具 ==========
  testTool: {
    getCloudGatewayStatus() {
      return request.get('/v1/test-tool/cloud-gateway/status')
    },

    submitCloudGatewayRequest(data) {
      return request.post('/v1/test-tool/cloud-gateway/requests', data)
    },

    createCloudGatewayMockAccount(channel) {
      return request.post('/v1/test-tool/cloud-gateway/mock-accounts', { channel })
    },

    sendCloudGatewayMockInbound(data) {
      return request.post('/v1/test-tool/cloud-gateway/mock-inbound', data)
    },

    getCloudGatewayEvent(eventId) {
      return request.get(`/v1/test-tool/cloud-gateway/events/${encodeURIComponent(eventId)}`)
    },

    // 按外部 user_id 查找会话
    findByUserId(userId) {
      return request.get(`/v1/test-tool/find-by-userId/${encodeURIComponent(userId)}`)
    },

    // 查看会话完整状态
    getConversation(id) {
      return request.get(`/v1/test-tool/conversation/${id}`)
    },

    // 重置为新客户状态
    resetToNew(id) {
      return request.post(`/v1/test-tool/conversation/${id}/reset-to-new`)
    },

    // 清除所有消息
    clearMessages(id) {
      return request.post(`/v1/test-tool/conversation/${id}/clear-messages`)
    },

    // 清除池操作日志
    clearPoolLogs(id) {
      return request.post(`/v1/test-tool/conversation/${id}/clear-pool-logs`)
    },

    // 清除 AI 回复日志
    clearAiLogs(id) {
      return request.post(`/v1/test-tool/conversation/${id}/clear-ai-logs`)
    },

    // 手动设置池类型和状态
    setPool(id, { poolType, convStatus, claimedBy } = {}) {
      return request.post(`/v1/test-tool/conversation/${id}/set-pool`, {
        poolType, convStatus, claimedBy
      })
    },

    // 彻底删除会话
    deleteConversation(id) {
      return request.delete(`/v1/test-tool/conversation/${id}`)
    }
  },

  // ========== WAHA 健康状态 ==========
  wahaStatus: {
    getHealthStatus() {
      return request.get('/v1/waha/health-status')
    }
  }
}
