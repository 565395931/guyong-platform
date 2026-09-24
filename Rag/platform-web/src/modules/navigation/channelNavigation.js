export const MENU_DEFINITION = [
  {
    type: 'group',
    key: 'customer-work',
    label: '客服工作',
    icon: 'Headset',
    roles: ['agent', 'supervisor', 'admin'],
    children: [
      {
        type: 'item',
        key: 'platform-messages',
        path: '/platform-messages',
        label: '平台消息',
        icon: 'ChatDotRound',
        children: [
          { type: 'item', key: 'platform-all', path: '/platform-messages?channel=all', label: '全部', icon: 'Menu', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-wecom', path: '/platform-messages?channel=wecom_kf', label: '微信客服', icon: 'ChatLineRound', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-wechat', path: '/platform-messages?channel=wechat', label: '微信小程序', icon: 'ChatDotRound', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-whatsapp', path: '/platform-messages?channel=whatsapp', label: 'WhatsApp', icon: 'ChatRound', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-douyin', path: '/platform-messages?channel=douyin', label: '抖店', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-pinduoduo', path: '/platform-messages?channel=pinduoduo', label: '拼多多', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-taobao', path: '/platform-messages?channel=taobao', label: '淘宝 / 千牛', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-1688', path: '/platform-messages?channel=alibaba1688', label: '1688', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-xiaohongshu', path: '/platform-messages?channel=xiaohongshu', label: '小红书', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-wechat-shop', path: '/platform-messages?channel=wechat_shop', label: '微信小店', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] },
          { type: 'item', key: 'platform-kuaishou', path: '/platform-messages?channel=kuaishou', label: '快手小店', icon: 'Shop', roles: ['agent', 'supervisor', 'admin'] }
        ],
        roles: ['agent', 'supervisor', 'admin']
      },
      {
        type: 'item',
        key: 'customer-service-accounts',
        path: '/customer-service-accounts',
        label: '客服账号管理',
        icon: 'Connection',
        children: [
          { type: 'item', key: 'accounts-all', path: '/customer-service-accounts?channel=all', label: '全部', icon: 'Menu', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-wecom', path: '/customer-service-accounts?channel=wecom_kf', label: '微信客服', icon: 'ChatLineRound', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-wechat', path: '/customer-service-accounts?channel=wechat', label: '微信小程序', icon: 'ChatDotRound', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-whatsapp', path: '/customer-service-accounts?channel=whatsapp', label: 'WhatsApp', icon: 'ChatRound', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-douyin', path: '/customer-service-accounts?channel=douyin', label: '抖店', icon: 'Shop', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-pinduoduo', path: '/customer-service-accounts?channel=pinduoduo', label: '拼多多', icon: 'Shop', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-taobao', path: '/customer-service-accounts?channel=taobao', label: '淘宝 / 千牛', icon: 'Shop', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-1688', path: '/customer-service-accounts?channel=alibaba1688', label: '1688', icon: 'Shop', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-xiaohongshu', path: '/customer-service-accounts?channel=xiaohongshu', label: '小红书', icon: 'Shop', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-wechat-shop', path: '/customer-service-accounts?channel=wechat_shop', label: '微信小店', icon: 'Shop', roles: ['supervisor', 'admin'] },
          { type: 'item', key: 'accounts-kuaishou', path: '/customer-service-accounts?channel=kuaishou', label: '快手小店', icon: 'Shop', roles: ['supervisor', 'admin'] }
        ],
        roles: ['supervisor', 'admin']
      },
      {
        type: 'item',
        key: 'message-reviews',
        path: '/message-reviews',
        label: '消息审核',
        icon: 'Warning',
        badge: 'review',
        roles: ['agent', 'supervisor', 'admin']
      }
    ]
  },
  {
    type: 'group',
    key: 'business-operations',
    label: '业务运营',
    icon: 'Briefcase',
    roles: ['agent', 'supervisor', 'admin'],
    children: [
      { type: 'item', key: 'statistics', path: '/statistics', label: '数据看板', icon: 'DataAnalysis', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'after-sales', path: '/statistics/after-sales', label: '售后分析', icon: 'TrendCharts', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'campaigns', path: '/campaigns', label: '主动营销', icon: 'Promotion', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'video', path: '/video', label: '视频生成', icon: 'VideoCamera', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'orders', path: '/orders', label: '订单管理', icon: 'ShoppingCart', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'catalog', path: '/catalog', label: '产品与报价', icon: 'Goods', roles: ['agent', 'supervisor', 'admin'] },
      { type: 'item', key: 'warehouses', path: '/warehouses', label: '仓库与库存', icon: 'Box', roles: ['supervisor', 'admin'] },
      { type: 'item', key: 'customers', path: '/customers', label: '客户管理', icon: 'User', roles: ['agent', 'supervisor', 'admin'] }
    ]
  },
  {
    type: 'group',
    key: 'system-settings',
    label: '系统设置',
    icon: 'Setting',
    roles: ['admin'],
    children: [
      { type: 'item', key: 'ai-config', path: '/settings/ai', label: 'AI 配置', icon: 'Setting', roles: ['admin'] },
      { type: 'item', key: 'modules', path: '/modules', label: '功能模块', icon: 'Tickets', roles: ['admin'] },
      { type: 'item', key: 'video-data', path: '/settings/video-data', label: '视频数据管理', icon: 'DataAnalysis', roles: ['admin'] }
    ]
  }
]

export function hasRequiredRole(requiredRoles, role) {
  return !Array.isArray(requiredRoles) || requiredRoles.length === 0 || requiredRoles.includes(role)
}

export function resolveAccountChannel(queryChannel, routeChannel) {
  const first = value => Array.isArray(value) ? value[0] : value
  const normalize = value => {
    const channel = first(value)
    return typeof channel === 'string' && channel.trim()
      ? channel.trim().toLowerCase()
      : 'all'
  }
  const explicitQuery = first(queryChannel)
  return typeof explicitQuery === 'string' && explicitQuery.trim()
    ? normalize(explicitQuery)
    : normalize(routeChannel)
}

export function buildSidebarMenu(role) {
  const cloneVisible = item => {
    if (!hasRequiredRole(item.roles, role)) return null
    const children = Array.isArray(item.children)
      ? item.children.map(cloneVisible).filter(Boolean)
      : undefined
    if (Array.isArray(item.children) && children.length === 0) return null
    return children ? { ...item, children } : { ...item }
  }
  return MENU_DEFINITION.map(cloneVisible).filter(Boolean)
}
