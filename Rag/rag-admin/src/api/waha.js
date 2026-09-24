/**
 * WAHA Session 管理 API 封装
 *
 * 独立 axios 实例，复用 admin.js 的拦截器逻辑
 */
import axios from 'axios'

const request = axios.create({
  baseURL: '/api',
  timeout: 30000
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
  error => Promise.reject(error)
)

// 响应拦截器 - 处理认证错误
request.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (window.location.pathname !== '/login') {
        window.location.replace('/login')
      }
    }
    return Promise.reject(error)
  }

)

export const wahaApi = {
  // ========== 实例池管理 ==========

  // 获取所有实例状态
  getInstances() {
    return request.get('/v1/waha/instances')
  },

  // 健康检查
  healthCheck() {
    return request.get('/v1/waha/health')
  },

  healthStatus() {
    return request.get('/v1/waha/health-status')
  },

  // 同步所有 WhatsApp 账号的联系人和历史消息
  syncAllHistory(data = {}) {
    return request.post('/v1/conversations/sync-all-history', data)
  },

  getSyncAllHistoryJob(jobId) {
    return request.get(`/v1/conversations/sync-all-history/jobs/${jobId}`)
  },

  // ========== Session 管理 ==========

  // 创建 session（自动分配实例）
  createSession(name) {
    return request.post('/v1/waha/sessions', { name })
  },

  // 重启 session
  restartSession(sessionName, accountId) {
    return request.post(`/v1/waha/sessions/${sessionName}/restart`, null, {
      params: accountId ? { accountId } : undefined
    })
  },

  // 获取二维码（返回 base64 图片）
  getQRCode(sessionName, accountId) {
    return request.get(`/v1/waha/sessions/${sessionName}/qr`, {
      params: accountId ? { accountId } : undefined
    })
  },

  // 获取 session 状态
  getSessionStatus(sessionName, accountId) {
    return request.get(`/v1/waha/sessions/${sessionName}/status`, {
      params: accountId ? { accountId } : undefined
    })
  },

  // 删除 session（解绑）
  deleteSession(sessionName, accountId) {
    return request.delete(`/v1/waha/sessions/${sessionName}`, {
      params: accountId ? { accountId } : undefined
    })
  },

  // ========== 渠道账号管理 ==========

  // 获取渠道账号列表
  getChannelAccounts(params = {}) {
    return request.get('/v1/channel-accounts', { params })
  },

  getChannels(params = {}) {
    return request.get('/v1/channel-accounts/channels', { params })
  },

  createChannel(data) {
    return request.post('/v1/channel-accounts/channels', data)
  },

  updateChannel(code, data) {
    return request.patch(`/v1/channel-accounts/channels/${code}`, data)
  },

  // 绑定渠道账号（自动分配实例）
  createChannelAccount(data) {
    return request.post('/v1/channel-accounts', data)
  },

  updateChannelAccount(id, data) {
    return request.patch(`/v1/channel-accounts/${id}`, data)
  },

  // 解绑渠道账号（同时销毁实例绑定）
  deleteChannelAccount(id) {
    return request.delete(`/v1/channel-accounts/${id}`)
  }
}
