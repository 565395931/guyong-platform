import axios from 'axios'

const request = axios.create({
  baseURL: '/api',
  timeout: 10000
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

// 响应拦截器 - 处理错误
request.interceptors.response.use(
  response => response,
  error => {
    // 处理不同的错误情况
    if (error.response) {
      // 服务器返回了响应
      const { status, data } = error.response
      
      if (status === 401) {
        // Token 过期或无效
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        // 不跳转，让组件处理
        return Promise.reject({
          success: false,
          message: data?.message || '认证失败，请重新登录',
          status
        })
      }
      
      // 其他错误，返回后端的错误信息
      return Promise.reject({
        success: false,
        message: data?.message || `请求失败 (${status})`,
        status
      })
    } else if (error.request) {
      // 请求已发出但没有收到响应（网络问题、服务器未启动）
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

export const authApi = {
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
  }
}

export default request