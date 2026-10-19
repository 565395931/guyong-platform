import { hasRequiredRole } from './channelNavigation.js'

const OPERATOR_ROLES = ['agent', 'admin']

const BUSINESS_ENTRIES = [
  { key: 'statistics', path: '/statistics', label: '数据看板', icon: 'DataAnalysis', roles: OPERATOR_ROLES },
  { key: 'after-sales', path: '/statistics/after-sales', label: '售后分析', icon: 'TrendCharts', roles: OPERATOR_ROLES },
  { key: 'campaigns', path: '/campaigns', label: '主动营销', icon: 'Promotion', roles: OPERATOR_ROLES },
  { key: 'video', path: '/video', label: '视频生成', icon: 'VideoCamera', roles: OPERATOR_ROLES },
  { key: 'orders', path: '/orders', label: '订单管理', icon: 'ShoppingCart', roles: OPERATOR_ROLES },
  { key: 'catalog', path: '/catalog', label: '产品与报价', icon: 'Goods', roles: OPERATOR_ROLES },
  { key: 'warehouses', path: '/warehouses', label: '仓库与库存', icon: 'Box', roles: ['admin'] },
  { key: 'customers', path: '/customers', label: '客户管理', icon: 'User', roles: OPERATOR_ROLES }
]

const SETTINGS_ENTRIES = [
  { key: 'general-settings', path: '/settings/general', label: '通用设置', icon: 'Setting', roles: ['admin'] },
  { key: 'system-accounts', path: '/settings/accounts', label: '系统账号管理', icon: 'User', roles: ['admin'] },
  { key: 'ai-config', path: '/settings/ai', label: 'AI 配置', icon: 'Setting', roles: ['admin'] },
  { key: 'model-test', path: '/settings/model-test', label: '大模型测试', icon: 'ChatDotRound', roles: ['admin'] },
  { key: 'modules', path: '/modules', label: '功能模块', icon: 'Tickets', roles: ['admin'] },
  { key: 'video-data', path: '/settings/video-data', label: '视频数据管理', icon: 'DataAnalysis', roles: ['admin'] }
]

const filterEntries = (entries, role) => entries
  .filter(item => hasRequiredRole(item.roles, role))
  .map(item => ({ ...item }))

export function buildHeaderNavigation(role) {
  return {
    business: filterEntries(BUSINESS_ENTRIES, role),
    settings: filterEntries(SETTINGS_ENTRIES, role)
  }
}
