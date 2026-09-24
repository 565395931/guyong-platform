import axios from 'axios'
import { ElMessage } from 'element-plus'
import { runtimeConfig } from '@/utils/runtimeConfig'
import { redirectToLogin } from '@/utils/sessionNavigation'

const request = axios.create({
  baseURL: runtimeConfig.apiBaseUrl,
  timeout: 30000
})

// 请求拦截器：注入 token
request.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('platform_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器：统一处理返回格式
request.interceptors.response.use(
  (response) => {
    // blob 类型直接返回（用于导出报表等场景）
    if (response.config.responseType === 'blob') {
      return response.data
    }
    const res = response.data
    if (res.success === false) {
      ElMessage.error(res.message || '请求失败')
      return Promise.reject(new Error(res.message || '请求失败'))
    }
    return res
  },
  (error) => {
    const authPageOwnsError = ['/auth/login', '/auth/setup', '/auth/setup-status']
      .some((path) => error.config?.url?.startsWith(path))

    if (error.code === 'ERR_CANCELED') {
      return Promise.reject(error)
    }
    if (error.response) {
      const { status, data } = error.response
      if (status === 401 && !authPageOwnsError) {
        ElMessage.error('登录已过期，请重新登录')
        redirectToLogin()
      } else if (!authPageOwnsError) {
        ElMessage.error(data?.message || `请求错误 (${status})`)
      }
    } else if (!authPageOwnsError) {
      ElMessage.error(error.message || '网络异常')
    }
    return Promise.reject(error)
  }
)

export default request
