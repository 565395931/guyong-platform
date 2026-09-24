import { defineStore } from 'pinia'
import { authApi } from '@/api/auth'

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    isLoggedIn: !!localStorage.getItem('token')
  }),

  actions: {
    // 登录
    async login(username, password) {
      try {
        const res = await authApi.login({ username, password })
        if (res.data.success) {
          this.token = res.data.data.token
          this.user = res.data.data.user
          this.isLoggedIn = true
          localStorage.setItem('token', this.token)
          localStorage.setItem('user', JSON.stringify(this.user))
        }
        return res.data
      } catch (error) {
        // 返回错误对象
        return {
          success: false,
          message: error.message || '登录失败'
        }
      }
    },

    // 注册
    async register(username, password, email) {
      try {
        const res = await authApi.register({ username, password, email })
        if (res.data.success) {
          this.token = res.data.data.token
          this.user = res.data.data.user
          this.isLoggedIn = true
          localStorage.setItem('token', this.token)
          localStorage.setItem('user', JSON.stringify(this.user))
        }
        return res.data
      } catch (error) {
        // 返回错误对象
        return {
          success: false,
          message: error.message || '注册失败'
        }
      }
    },

    // 登出
    logout() {
      this.token = ''
      this.user = null
      this.isLoggedIn = false
      localStorage.removeItem('token')
      localStorage.removeItem('user')
    },

    // 获取当前用户信息
    async fetchCurrentUser() {
      if (!this.token) return null
      try {
        const res = await authApi.getCurrentUser()
        if (res.data.success) {
          this.user = res.data.data
          localStorage.setItem('user', JSON.stringify(this.user))
        }
        return res.data
      } catch (error) {
        this.logout()
        return {
          success: false,
          message: error.message || '获取用户信息失败'
        }
      }
    },

    // 修改密码
    async changePassword(oldPassword, newPassword) {
      try {
        const res = await authApi.changePassword({ oldPassword, newPassword })
        return res.data
      } catch (error) {
        return {
          success: false,
          message: error.message || '修改密码失败'
        }
      }
    }
  }
})