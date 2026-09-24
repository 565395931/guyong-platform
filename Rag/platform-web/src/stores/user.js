import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as loginApi, setupOwner as setupOwnerApi } from '@/api/auth'
import { websocketService } from '@/api/websocket'
import { redirectToLogin } from '@/utils/sessionNavigation'

export const useUserStore = defineStore('user', () => {
  // state
  const token = ref(localStorage.getItem('platform_token') || '')
  const userInfo = ref(JSON.parse(localStorage.getItem('platform_user') || 'null'))
  const permissions = ref([])

  // getter
  const isLoggedIn = computed(() => !!token.value)

  // actions
  async function login(payload, password, captchaToken, captchaCode) {
    const body = typeof payload === 'object' && payload !== null
      ? payload
      : { username: payload, password, captchaToken, captchaCode }

    const res = await loginApi(body)
    if (res.success) {
      setToken(res.data.token)
      setUserInfo(res.data.user || { username: body.username })
      return { success: true }
    }
    return { success: false, message: res.message }
  }

  async function setupOwner(payload) {
    const res = await setupOwnerApi(payload)
    if (res.success) {
      setToken(res.data.token)
      setUserInfo(res.data.user)
      return { success: true }
    }
    return { success: false, message: res.message }
  }

  function setToken(newToken) {
    token.value = newToken
    localStorage.setItem('platform_token', newToken)
  }

  function setUserInfo(info) {
    userInfo.value = info
    localStorage.setItem('platform_user', JSON.stringify(info))
  }

  function logout() {
    // 断开 WebSocket 连接
    websocketService.disconnect()
    token.value = ''
    userInfo.value = null
    permissions.value = []
    redirectToLogin()
  }

  return {
    token,
    userInfo,
    permissions,
    isLoggedIn,
    login,
    setupOwner,
    setToken,
    setUserInfo,
    logout
  }
})
