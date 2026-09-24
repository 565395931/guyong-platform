<template>
  <main class="login-view">
    <section class="login-view__card" :aria-busy="mode === 'loading'">
      <div class="login-view__header">
        <div class="login-view__logo" aria-hidden="true"><el-icon :size="44"><Headset /></el-icon></div>
        <div class="login-view__eyebrow">LOCAL SERVICE CONSOLE</div>
        <h1 class="login-view__title">{{ isSetup ? '初始化本地工作台' : '客服聚合工作台' }}</h1>
        <p class="login-view__subtitle">{{ isSetup ? '创建此设备唯一的管理员账号' : '多渠道消息聚合 · RAG 智能辅助 · 高效运营' }}</p>
      </div>

      <div v-if="mode === 'loading'" class="login-view__loading" role="status">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon><span>正在检查本机初始化状态…</span>
      </div>

      <template v-else-if="mode === 'error'">
        <el-alert type="error" :closable="false" show-icon title="无法连接本地服务">
          <template #default>{{ statusError }}</template>
        </el-alert>
        <el-button class="login-view__retry" type="primary" plain @click="loadSetupStatus">重新检查</el-button>
      </template>

      <template v-else>
        <el-alert class="login-view__notice" type="info" :closable="false" show-icon>
          <template #title>{{ isSetup ? '仅首次设置' : '本机账号登录' }}</template>
          <template #default>{{ isSetup ? '创建成功后初始化入口会自动关闭。请保存好账号密码。' : '本系统不开放公开注册，请使用本机管理员账号登录。' }}</template>
        </el-alert>

        <div v-if="formError" class="login-view__error" role="alert">{{ formError }}</div>

        <el-form ref="formRef" :model="form" :rules="rules" class="login-view__form" label-position="top" novalidate @submit.prevent="handleSubmit">
          <el-form-item prop="username" :label="isSetup ? '管理员账号' : '账号'">
            <el-input v-model="form.username" :prefix-icon="User" autocomplete="username" placeholder="请输入账号" clearable />
          </el-form-item>
          <el-form-item prop="password" label="密码">
            <el-input v-model="form.password" type="password" :prefix-icon="Lock" :autocomplete="isSetup ? 'new-password' : 'current-password'" :placeholder="isSetup ? '至少 8 个字符' : '请输入密码'" show-password />
          </el-form-item>
          <el-form-item v-if="isSetup" prop="confirmPassword" label="确认密码">
            <el-input v-model="form.confirmPassword" type="password" :prefix-icon="Lock" autocomplete="new-password" placeholder="再次输入密码" show-password />
          </el-form-item>
          <el-form-item class="login-view__action">
            <el-button native-type="submit" type="primary" class="login-view__submit" :loading="submitting" :disabled="submitting">{{ submitLabel }}</el-button>
          </el-form-item>
        </el-form>
      </template>

      <footer class="login-view__footer">
        <div v-if="runtimeConfig.isDesktop" class="login-view__connection">
          <el-button link type="primary" @click="openDesktopSettings">连接设置</el-button>
          <span :title="runtimeConfig.serverUrl">{{ runtimeConfig.serverUrl || '开发代理' }}</span>
        </div>
        <span>© 2026 客服聚合工作台 · 数据保存在本机</span>
      </footer>
    </section>
  </main>
</template>

<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Headset, Loading, Lock, User } from '@element-plus/icons-vue'
import { getSetupStatus } from '@/api/auth'
import { useUserStore } from '@/stores/user'
import { runtimeConfig } from '@/utils/runtimeConfig'

const openDesktopSettings = inject('openDesktopSettings', () => {})
const router = useRouter()
const userStore = useUserStore()
const formRef = ref(null)
const mode = ref('loading')
const submitting = ref(false)
const statusError = ref('')
const formError = ref('')
const form = reactive({ username: 'admin', password: '', confirmPassword: '' })
const isSetup = computed(() => mode.value === 'setup')
const submitLabel = computed(() => submitting.value ? (isSetup.value ? '正在创建…' : '正在登录…') : (isSetup.value ? '创建管理员并进入系统' : '登录'))

function validateConfirmation(rule, value, callback) {
  if (!isSetup.value) return callback()
  if (!value) return callback(new Error('请再次输入密码'))
  if (value !== form.password) return callback(new Error('两次输入的密码不一致'))
  callback()
}

const rules = {
  username: [
    { required: true, message: '请输入账号', trigger: 'blur' },
    { pattern: /^[\w.-]{2,50}$/, message: '请输入 2-50 位字母、数字、下划线、点或短横线', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 8, max: 72, message: '密码长度须为 8-72 个字符', trigger: 'blur' }
  ],
  confirmPassword: [{ validator: validateConfirmation, trigger: ['blur', 'change'] }]
}

async function loadSetupStatus() {
  mode.value = 'loading'
  statusError.value = ''
  try {
    const response = await getSetupStatus()
    mode.value = response.data.needsSetup ? 'setup' : 'login'
  } catch (error) {
    statusError.value = error?.message || '请确认后端服务已经启动，然后重试。'
    mode.value = 'error'
  }
}

async function handleSubmit() {
  if (!formRef.value || submitting.value) return
  formError.value = ''
  try {
    await formRef.value.validate()
    submitting.value = true
    const result = isSetup.value
      ? await userStore.setupOwner({ username: form.username.trim(), password: form.password })
      : await userStore.login({ username: form.username.trim(), password: form.password })
    if (!result.success) throw new Error(result.message || '操作失败')
    await router.push('/platform-messages')
  } catch (error) {
    if (error?.message) formError.value = error.message
  } finally {
    submitting.value = false
  }
}

onMounted(loadSetupStatus)
</script>

<style scoped lang="scss">
.login-view {
  position: relative; display: grid; place-items: center; min-height: 100vh; padding: 24px; overflow: auto;
  background: linear-gradient(135deg, #0c2e5e 0%, #1565c0 50%, #1e88e5 100%);
  &::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 20% 25%, rgba(147, 197, 253, .2), transparent 42%), radial-gradient(circle at 82% 76%, rgba(56, 189, 248, .14), transparent 46%); pointer-events: none; }
  &__card { position: relative; box-sizing: border-box; width: min(440px, 100%); padding: 36px 36px 26px; background: rgba(255, 255, 255, .98); border: 1px solid rgba(255, 255, 255, .7); border-radius: 16px; box-shadow: 0 20px 60px rgba(15, 23, 42, .28); }
  &__header { text-align: center; margin-bottom: 20px; }
  &__logo { display: inline-flex; align-items: center; justify-content: center; width: 72px; height: 72px; margin-bottom: 14px; border-radius: 18px; background: linear-gradient(135deg, #1565c0, #42a5f5); color: #fff; box-shadow: 0 8px 24px rgba(21, 101, 192, .3); }
  &__eyebrow { margin-bottom: 7px; color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .16em; }
  &__title { margin: 0 0 8px; color: #1e3a8a; font-size: 26px; line-height: 1.3; }
  &__subtitle { margin: 0; color: #64748b; font-size: 13px; line-height: 1.6; }
  &__notice { margin-bottom: 18px; border-radius: 10px; }
  &__loading { display: flex; min-height: 180px; align-items: center; justify-content: center; gap: 10px; color: #475569; }
  &__retry { width: 100%; height: 44px; margin-top: 18px; }
  &__error { margin-bottom: 16px; padding: 10px 12px; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; font-size: 13px; line-height: 1.5; }
  &__form :deep(.el-form-item__label) { color: #334155; font-weight: 600; }
  &__form :deep(.el-input__wrapper) { min-height: 44px; border-radius: 8px; }
  &__action { margin-top: 6px; margin-bottom: 0; }
  &__submit { width: 100%; height: 44px; border-color: #2563eb; border-radius: 8px; background: #2563eb; font-size: 15px; font-weight: 700; }
  &__submit:not(.is-disabled):hover { border-color: #1d4ed8; background: #1d4ed8; }
  &__footer { margin-top: 22px; text-align: center; color: #94a3b8; font-size: 12px; }
  &__connection { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 10px; color: #606266; }
  &__connection span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) { .login-view * { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
</style>
