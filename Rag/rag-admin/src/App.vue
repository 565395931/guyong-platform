<template>
  <div class="app-wrapper">
    <!-- 侧边栏 -->
    <aside class="sidebar" :class="{ 'sidebar--collapsed': collapsed }">
      <div class="sidebar__logo">
        <div class="sidebar__logo-icon">◈</div>
        <span v-show="!collapsed" class="sidebar__logo-text">孤勇者</span>
      </div>
      <nav class="sidebar__nav">
        <div class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/dashboard' }" @click="navigate('/dashboard')">
          <el-icon><Odometer /></el-icon>
          <span v-show="!collapsed">仪表盘</span>
        </div>
        <div v-if="hasRole(['admin', 'supervisor'])" class="sidebar__group">
          <div class="sidebar__nav-item sidebar__nav-item--parent" :class="{ 'is-open': openGroups.knowledge }" @click="toggleGroup('knowledge')">
            <el-icon><Reading /></el-icon>
            <span v-show="!collapsed">知识库管理</span>
            <el-icon v-show="!collapsed" class="sidebar__arrow"><ArrowDown /></el-icon>
          </div>
          <div v-show="openGroups.knowledge && !collapsed" class="sidebar__sub">
            <div class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/knowledge/documents' }" @click="navigate('/knowledge/documents')">文档管理</div>
            <div class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/knowledge/qa' }" @click="navigate('/knowledge/qa')">问答管理</div>
          </div>
        </div>
        <div v-if="hasRole(['admin', 'supervisor'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/users' }" @click="navigate('/users')">
          <el-icon><User /></el-icon>
          <span v-show="!collapsed">坐席管理</span>
        </div>
        <div v-if="hasRole(['admin', 'supervisor', 'agent'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/sessions' }" @click="navigate('/sessions')">
          <el-icon><ChatDotRound /></el-icon>
          <span v-show="!collapsed">会话记录</span>
        </div>
        <div v-if="hasRole(['admin', 'supervisor'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/templates' }" @click="navigate('/templates')">
          <el-icon><Document /></el-icon>
          <span v-show="!collapsed">模板管理</span>
        </div>
        <div v-if="hasRole(['admin'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/channels/accounts' || $route.path === '/channels/whatsapp' }" @click="navigate('/channels/accounts')">
          <el-icon><Cellphone /></el-icon>
          <span v-show="!collapsed">账号管理</span>
        </div>
        <div v-if="hasRole(['admin', 'supervisor'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/pool-logs' }" @click="navigate('/pool-logs')">
          <el-icon><DataLine /></el-icon>
          <span v-show="!collapsed">池操作日志</span>
        </div>
        <div v-if="hasRole(['admin'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/system-logs' }" @click="navigate('/system-logs')">
          <el-icon><Tools /></el-icon>
          <span v-show="!collapsed">系统日志</span>
        </div>
        <div v-if="hasRole(['admin', 'supervisor'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/media-files' }" @click="navigate('/media-files')">
          <el-icon><FolderOpened /></el-icon>
          <span v-show="!collapsed">文件上传</span>
        </div>
        <div v-if="hasRole(['admin', 'supervisor'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/quick-replies' }" @click="navigate('/quick-replies')">
          <el-icon><Tickets /></el-icon>
          <span v-show="!collapsed">快捷指令</span>
        </div>
        <div v-if="hasRole(['admin'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/settings' }" @click="navigate('/settings')">
          <el-icon><Setting /></el-icon>
          <span v-show="!collapsed">系统设置</span>
        </div>
        <div v-if="hasRole(['admin'])" class="sidebar__nav-item" :class="{ 'is-active': $route.path === '/test-tool' }" @click="navigate('/test-tool')">
          <el-icon><Tools /></el-icon>
          <span v-show="!collapsed">测试工具</span>
        </div>
      </nav>
      <div class="sidebar__footer" @click="collapsed = !collapsed">
        <el-icon><Fold v-if="!collapsed" /><Expand v-else /></el-icon>
        <span v-show="!collapsed">收起菜单</span>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="main-area">
      <header class="topbar">
        <div class="topbar__left">
          <span class="topbar__title">{{ currentRouteName }}</span>
          <span class="topbar__badge">ADMIN</span>
        </div>
        <div class="topbar__right">
          <WahaStatusIndicator />
          <div class="topbar__status">
            <span class="topbar__dot"></span>
            <span>系统在线</span>
          </div>
          <el-dropdown>
            <div class="topbar__user">
              <div class="topbar__avatar">{{ username.charAt(0).toUpperCase() }}</div>
              <span class="topbar__username">{{ username }}</span>
              <el-icon><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item>个人设置</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Odometer, Reading, User, ChatDotRound, Setting, UserFilled,
  Document, ArrowDown, Fold, Expand, Cellphone, DataLine, Tools, FolderOpened, Tickets
} from '@element-plus/icons-vue'
import WahaStatusIndicator from '@/components/WahaStatusIndicator.vue'

const route = useRoute()
const router = useRouter()

const collapsed = ref(false)
const openGroups = reactive({ knowledge: true })

const username = computed(() => {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    return user.username || '管理员'
  } catch {
    return '管理员'
  }
})

// 用户角色（响应式，路由变化时重新读取 localStorage）
const userRole = ref('user')

const updateRole = () => {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    userRole.value = user.role || 'user'
  } catch {
    userRole.value = 'user'
  }
}

updateRole()
watch(() => route.path, updateRole)

// 检查是否有权限
const hasRole = (roles) => roles.includes(userRole.value)

const currentRouteName = computed(() => {
  const nameMap = {
    '/system-logs': '系统日志',
    '/dashboard': '仪表盘',
    '/knowledge/documents': '文档管理',
    '/knowledge/qa': '问答管理',
    '/users': '坐席管理',
    '/sessions': '会话记录',
    '/templates': '模板管理',
    '/channels/whatsapp': '账号管理',
    '/channels/accounts': '账号管理',
    '/pool-logs': '池操作日志',
    '/media-files': '文件上传',
    '/quick-replies': '快捷指令',
    '/settings': '系统设置',
    '/test-tool': '测试工具'
  }
  return nameMap[route.path] || '首页'
})

const navigate = (path) => router.push(path)
const toggleGroup = (key) => { openGroups[key] = !openGroups[key] }

// 退出登录
const handleLogout = async () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  await router.replace('/login')
}

</script>
<style>
body {
  margin: 0;
}
</style>
<style scoped lang="scss">

.app-wrapper {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: #0f172a;
  box-sizing: border-box;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

// ========== 侧边栏 ==========
.sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
  border-right: 1px solid rgba(51, 65, 85, 0.8);
  transition: width 0.3s ease;
  position: relative;
  z-index: 10;

  &::before {
    content: '';
    position: absolute;
    top: 0; right: 0;
    width: 1px; height: 100%;
    background: linear-gradient(180deg, transparent, rgba(59, 130, 246, 0.5), transparent);
  }

  &--collapsed { width: 64px; }

  &__logo {
    height: 60px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 20px;
    border-bottom: 1px solid rgba(51, 65, 85, 0.5);
  }

  &__logo-icon {
    font-size: 24px;
    color: #3b82f6;
    text-shadow: 0 0 12px rgba(59, 130, 246, 0.6);
    flex-shrink: 0;
  }

  &__logo-text {
    font-size: 16px;
    font-weight: 700;
    color: #e2e8f0;
    letter-spacing: 2px;
    white-space: nowrap;
  }

  &__nav {
    flex: 1;
    overflow-y: auto;
    padding: 12px 0;

    &::-webkit-scrollbar { width: 4px; }
    &::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
  }

  &__nav-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 20px;
    height: 44px;
    cursor: pointer;
    color: #94a3b8;
    font-size: 14px;
    transition: all 0.2s;
    position: relative;
    white-space: nowrap;
    overflow: hidden;

    .el-icon { font-size: 18px; flex-shrink: 0; }

    &:hover {
      color: #e2e8f0;
      background: rgba(59, 130, 246, 0.08);
    }

    &.is-active {
      color: #60a5fa;
      background: rgba(59, 130, 246, 0.12);

      &::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 3px;
        background: linear-gradient(180deg, #3b82f6, #60a5fa);
        box-shadow: 0 0 8px rgba(59, 130, 246, 0.6);
      }
    }

    &--parent { justify-content: flex-start; }
  }

  &__arrow {
    margin-left: auto;
    font-size: 12px !important;
    transition: transform 0.2s;
  }

  &__group.is-open &__arrow { transform: rotate(0deg); }

  &__sub {
    padding: 4px 0 4px 52px;

    .sidebar__nav-item {
      height: 38px;
      font-size: 13px;
      padding: 0 20px;

      &.is-active::before { left: -52px; }
    }
  }

  &__footer {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 20px;
    cursor: pointer;
    color: #64748b;
    font-size: 13px;
    border-top: 1px solid rgba(51, 65, 85, 0.5);
    transition: color 0.2s;

    &:hover { color: #94a3b8; }
    .el-icon { font-size: 18px; flex-shrink: 0; }
  }
}

// ========== 主区域 ==========
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar {
  position: relative;
  z-index: 30;
  overflow: visible;
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: rgba(30, 41, 59, 0.8);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(51, 65, 85, 0.6);

  &__left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__title {
    font-size: 17px;
    font-weight: 600;
    color: #e2e8f0;
  }

  &__badge {
    font-size: 10px;
    font-weight: 700;
    color: #3b82f6;
    background: rgba(59, 130, 246, 0.15);
    border: 1px solid rgba(59, 130, 246, 0.3);
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 1px;
  }

  &__right {
    display: flex;
    align-items: center;
    gap: 24px;
  }

  &__status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #64748b;
  }

  &__dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
    animation: pulse 2s infinite;
  }

  &__user {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    color: #94a3b8;
    transition: color 0.2s;

    &:hover { color: #e2e8f0; }
    .el-icon { font-size: 12px; }
  }

  &__avatar {
    width: 30px; height: 30px;
    border-radius: 6px;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 12px rgba(59, 130, 246, 0.3);
  }

  &__username {
    font-size: 13px;
  }
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  box-sizing: border-box;
  background: #f1f5f9;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
  &::-webkit-scrollbar-track { background: transparent; }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

// 全局覆盖 Element Plus 菜单样式
:deep(.el-menu) {
  background: transparent !important;
  border-right: none !important;
}
</style>
