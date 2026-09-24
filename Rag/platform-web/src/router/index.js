import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { hasRequiredRole } from '@/modules/navigation/channelNavigation'
import { redirectLegacyRoute } from '@/modules/navigation/legacyRouteRedirects'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login/LoginView.vue'),
    meta: { noAuth: true }
  },
  {
    path: '/',
    component: () => import('@/components/Layout/AppLayout.vue'),
    redirect: '/platform-messages',
    children: [
      {
        path: 'platform-messages',
        name: 'PlatformMessages',
        component: () => import('@/views/PlatformMessages/PlatformMessagesView.vue'),
        meta: { title: '平台消息', requiredRoles: ['agent', 'supervisor', 'admin'] }
      },
      {
        path: 'customer-service-accounts',
        name: 'CustomerServiceAccounts',
        component: () => import('@/views/Settings/CustomerServiceAccountsView.vue'),
        meta: { title: '客服账号管理', requiredRoles: ['supervisor', 'admin'] }
      },
      {
        path: 'workbench',
        name: 'Workbench',
        redirect: redirectLegacyRoute
      },
      {
        path: 'message-reviews',
        name: 'MessageReviews',
        component: () => import('@/views/MessageReviews/MessageReviewView.vue'),
        meta: { title: '消息审核', requiredRoles: ['agent', 'supervisor', 'admin'] }
      },
      {
        path: 'settings/ai',
        name: 'AiConfig',
        component: () => import('@/views/Settings/AiConfigView.vue'),
        meta: { title: 'AI 配置', requiredRoles: ['admin'] }
      },
      {
        path: 'settings/video-data',
        name: 'VideoDataManage',
        component: () => import('@/views/Settings/VideoDataManageView.vue'),
        meta: { title: '视频数据管理', requiredRoles: ['admin'] }
      },
      {
        path: 'wecom/conversations',
        name: 'WecomConversations',
        redirect: redirectLegacyRoute
      },
      {
        path: 'wecom/accounts',
        name: 'WecomAccounts',
        redirect: redirectLegacyRoute
      },
      {
        path: 'platform-accounts',
        redirect: redirectLegacyRoute
      },
      {
        path: 'whatsapp/conversations',
        name: 'WhatsappConversations',
        redirect: redirectLegacyRoute
      },
      {
        path: 'douyin/events',
        name: 'DouyinEvents',
        redirect: redirectLegacyRoute
      },
      {
        path: 'douyin/accounts',
        name: 'DouyinAccounts',
        redirect: redirectLegacyRoute
      },
      {
        path: 'pinduoduo/events',
        name: 'PinduoduoEvents',
        redirect: redirectLegacyRoute
      },
      {
        path: 'pinduoduo/accounts',
        name: 'PinduoduoAccounts',
        redirect: redirectLegacyRoute
      },
      {
        path: 'taobao/events',
        name: 'TaobaoEvents',
        redirect: redirectLegacyRoute
      },
      {
        path: 'taobao/accounts',
        name: 'TaobaoAccounts',
        redirect: redirectLegacyRoute
      },
      {
        path: '1688/events',
        name: 'Alibaba1688Events',
        redirect: redirectLegacyRoute
      },
      {
        path: '1688/accounts',
        name: 'Alibaba1688Accounts',
        redirect: redirectLegacyRoute
      },
      {
        path: 'statistics',
        name: 'Dashboard',
        component: () => import('@/views/Statistics/DashboardView.vue'),
        meta: { title: '数据看板' }
      },
      {
        path: 'statistics/after-sales',
        name: 'AfterSales',
        component: () => import('@/views/Statistics/AfterSalesView.vue'),
        meta: { title: '售后分析' }
      },
      {
        path: 'campaigns',
        name: 'TaskList',
        component: () => import('@/views/Campaigns/TaskList.vue'),
        meta: { title: '主动营销' }
      },
      {
        path: 'campaigns/create',
        name: 'TaskCreate',
        component: () => import('@/views/Campaigns/TaskCreate.vue'),
        meta: { title: '新建任务' }
      },
      {
        path: 'video',
        name: 'VideoGenerate',
        component: () => import('@/views/Video/VideoGenerate.vue'),
        meta: { title: '视频生成' }
      },
      {
        path: 'orders',
        name: 'Orders',
        component: () => import('@/views/Orders/OrdersView.vue'),
        meta: { title: '订单管理' }
      },
      {
        path: 'catalog',
        name: 'Catalog',
        component: () => import('@/views/Catalog/CatalogView.vue'),
        meta: { title: '产品与报价' }
      },
      {
        path: 'warehouses',
        name: 'Warehouses',
        component: () => import('@/views/Warehouses/WarehouseView.vue'),
        meta: { title: '仓库与库存', requiredRoles: ['supervisor', 'admin'] }
      },
      {
        path: 'customers',
        name: 'Customers',
        component: () => import('@/views/Customers/CustomersView.vue'),
        meta: { title: '客户管理' }
      },
      {
        path: 'customers/:id/profile',
        name: 'CustomerProfile',
        component: () => import('@/views/Customers/CustomerProfileView.vue'),
        meta: { title: '客户画像' }
      },
      {
        path: 'modules',
        name: 'Modules',
        component: () => import('@/views/Modules/ModulesView.vue'),
        meta: { title: '功能模块' }
      }
    ]
  }
]

const router = createRouter({
  // file:// 方式加载桌面构建时必须使用 hash 路由，避免刷新子路径找不到本地 index.html。
  history: typeof window !== 'undefined' && window.desktopBridge?.isDesktop
    ? createWebHashHistory()
    : createWebHistory(),
  routes
})

// 路由守卫：未登录跳转 /login，已登录访问 /login 重定向到统一消息入口
router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('platform_token')

  if (!to.meta.noAuth && !token) {
    next('/login')
  } else if (to.path === '/login' && token) {
    next('/platform-messages')
  } else if (to.meta.requiredRoles) {
    let role = ''
    try {
      role = JSON.parse(localStorage.getItem('platform_user') || 'null')?.role || ''
    } catch {
      role = ''
    }
    next(hasRequiredRole(to.meta.requiredRoles, role) ? undefined : '/platform-messages')
  } else {
    next()
  }
})

export default router
