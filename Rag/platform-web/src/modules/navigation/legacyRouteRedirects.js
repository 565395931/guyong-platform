const LEGACY_ROUTES = new Map([
  ['/workbench', { path: '/platform-messages', query: { view: 'conversations' } }],
  ['/wecom/conversations', { path: '/platform-messages', query: { channel: 'wecom_kf', view: 'conversations' } }],
  ['/whatsapp/conversations', { path: '/platform-messages', query: { channel: 'whatsapp', view: 'conversations' } }],
  ['/douyin/events', { path: '/platform-messages', query: { channel: 'douyin', view: 'events' } }],
  ['/pinduoduo/events', { path: '/platform-messages', query: { channel: 'pinduoduo', view: 'events' } }],
  ['/taobao/events', { path: '/platform-messages', query: { channel: 'taobao', view: 'events' } }],
  ['/1688/events', { path: '/platform-messages', query: { channel: 'alibaba1688', view: 'events' } }],
  ['/wecom/accounts', { path: '/customer-service-accounts', query: { channel: 'wecom_kf' } }],
  ['/platform-accounts', { path: '/customer-service-accounts', query: { channel: 'wecom_kf' } }],
  ['/douyin/accounts', { path: '/customer-service-accounts', query: { channel: 'douyin' } }],
  ['/pinduoduo/accounts', { path: '/customer-service-accounts', query: { channel: 'pinduoduo' } }],
  ['/taobao/accounts', { path: '/customer-service-accounts', query: { channel: 'taobao' } }],
  ['/1688/accounts', { path: '/customer-service-accounts', query: { channel: 'alibaba1688' } }]
])

export function resolveLegacyRoute(path) {
  const target = LEGACY_ROUTES.get(path)
  return target
    ? { path: target.path, query: { ...target.query } }
    : null
}

export function redirectLegacyRoute(to) {
  const target = resolveLegacyRoute(to.path)
  if (!target) return { path: '/platform-messages' }
  return {
    path: target.path,
    query: { ...(to.query || {}), ...target.query }
  }
}
