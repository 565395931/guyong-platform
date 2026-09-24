import axios from 'axios'

const request = axios.create({
  baseURL: '/api',
  timeout: 60000 // RAG问答可能需要更长时间
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

// 响应拦截器 - 统一错误处理
request.interceptors.response.use(
  response => response,
  error => {
    // 处理不同的错误情况
    if (error.response) {
      // 服务器返回了响应
      const { status, data } = error.response

      // 提取错误信息，兼容多种格式
      const errorMessage = data?.message || data?.error || data?.msg || `请求失败 (${status})`

      if (status === 401) {
        // Token 过期或无效
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        return Promise.reject({
          success: false,
          message: errorMessage,
          status
        })
      }

      // 其他错误，返回后端的错误信息
      return Promise.reject({
        success: false,
        message: errorMessage,
        status,
        data // 保留原始错误数据供调试
      })
    } else if (error.request) {
      // 请求已发出但没有收到响应
      return Promise.reject({
        success: false,
        message: '服务器连接失败，请检查服务器是否启动',
        status: 503
      })
    } else {
      // 其他错误
      return Promise.reject({
        success: false,
        message: error.message || '请求发送失败'
      })
    }
  }
)

export const chatApi = {
  // 创建会话 thread
  createThread(userId = 'anonymous') {
    return request.post('/langchain/threads', { user_id: userId })
  },

  // 获取用户会话列表
  getThreads(userId = 'anonymous') {
    return request.get('/langchain/threads', { params: { user_id: userId } })
  },

  // 获取会话状态
  getThreadState(threadId) {
    return request.get(`/langchain/threads/${threadId}/state`)
  },

  // 删除会话
  deleteThread(threadId) {
    return request.delete(`/langchain/threads/${threadId}`)
  },

  // 发送消息(流式)
  sendMessage(threadId, message, config = {}) {
    return request.post('/langchain/runs/stream', {
      thread_id,
      input: { messages: [{ content: message }] },
      config: { configurable: config }
    })
  },

  // 上传并解析附件
  uploadAttachment(file) {
    const formData = new FormData()
    formData.append('file', file)
    return request.post('/chat/attachment/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 120000 // 上传解析可能需要较长时间
    })
  },

  // 批量上传附件
  uploadAttachments(files) {
    const formData = new FormData()
    files.forEach(file => formData.append('files', file))
    return request.post('/chat/attachment/upload-batch', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 180000
    })
  }
}