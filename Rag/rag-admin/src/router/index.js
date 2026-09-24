import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/',
    redirect: '/dashboard'
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor', 'agent', 'user'] }
  },
  {
    path: '/knowledge',
    redirect: '/knowledge/documents',
    meta: { requiresAuth: true, roles: ['admin', 'supervisor'] },
    children: [
      {
        path: 'documents',
        name: 'Documents',
        component: () => import('@/views/knowledge/Documents.vue'),
        meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
      },
      {
        path: 'qa',
        name: 'QA',
        component: () => import('@/views/knowledge/QA.vue'),
        meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
      }
    ]
  },
  {
    path: '/users',
    name: 'Users',
    component: () => import('@/views/Users.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
  },
  {
    path: '/sessions',
    name: 'Sessions',
    component: () => import('@/views/Sessions.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor', 'agent'] }
  },
  {
    path: '/templates',
    name: 'Templates',
    component: () => import('@/views/Template.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
  },
  {
    path: '/channels/whatsapp',
    redirect: '/channels/accounts',
    meta: { requiresAuth: true, roles: ['admin'] }
  },
  {
    path: '/channels/accounts',
    name: 'ChannelAccounts',
    component: () => import('@/views/WhatsAppAccounts.vue'),
    meta: { requiresAuth: true, roles: ['admin'] }
  },
  {
    path: '/pool-logs',
    name: 'PoolLogs',
    component: () => import('@/views/PoolLogs.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
  },
  {
    path: '/system-logs',
    name: 'SystemLogs',
    component: () => import('@/views/SystemLogs.vue'),
    meta: { requiresAuth: true, roles: ['admin'] }
  },
  {
    path: '/media-files',
    name: 'MediaFiles',
    component: () => import('@/views/MediaFiles.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
  },
  {
    path: '/quick-replies',
    name: 'QuickReplies',
    component: () => import('@/views/QuickReplies.vue'),
    meta: { requiresAuth: true, roles: ['admin', 'supervisor'] }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/Settings.vue'),
    meta: { requiresAuth: true, roles: ['admin'] }
  },
  {
    path: '/test-tool',
    name: 'TestTool',
    component: () => import('@/views/TestTool.vue'),
    meta: { requiresAuth: true, roles: ['admin'] }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// 获取当前用户角色
function getUserRole() {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    return user.role || 'user'
  } catch {
    return 'user'
  }
}

// 路由守卫 - 检查登录状态和角色权限
router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')

  if (to.meta.requiresAuth && !token) {
    // 需要登录但没有 token，跳转到登录页
    next('/login')
  } else if (to.path === '/login' && token) {
    // 已登录但访问登录页，跳转到首页
    next('/dashboard')
  } else if (to.meta.roles) {
    // 检查角色权限
    const userRole = getUserRole()
    if (to.meta.roles.includes(userRole)) {
      next()
    } else {
      // 无权限，跳转到首页
      next('/dashboard')
    }
  } else {
    next()
  }
})

export default router
