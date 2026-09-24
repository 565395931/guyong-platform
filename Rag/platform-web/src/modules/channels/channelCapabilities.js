const NO_CAPABILITIES = Object.freeze({
  customerMessagesIn: false,
  customerMessagesOut: false,
  orderEvents: false,
  afterSalesEvents: false,
  productEvents: false,
  requiresPublicCallback: false,
  limitation: '渠道能力尚未定义'
})

const CHANNEL_CAPABILITIES = Object.freeze({
  douyin: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: '抖店官方目前未开放飞鸽客服收发消息 API，本系统只接订单/售后/商品事件'
  }),
  pinduoduo: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '拼多多官方商家 API 当前未提供买家客服聊天收发能力，本系统只同步订单和售后事件'
  }),
  taobao: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '淘宝开放平台公开服务端 API 不提供独立网页买家聊天发送能力，本系统只同步订单和退款事件'
  }),
  alibaba1688: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: false,
    requiresPublicCallback: false,
    limitation: '1688 公开服务端 API 不提供独立网页买家聊天发送能力，本系统只同步加密场景订单和退款事件'
  }),
  xiaohongshu: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    chatTransport: 'desktop_bridge',
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: '官方 API 同步商品、订单和售后事件；客服聊天通过桌面消息桥接入。'
  }),
  wechat_shop: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    chatTransport: 'desktop_bridge',
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: '官方 API 同步商品、订单和售后事件；客服聊天通过桌面消息桥接入。'
  }),
  kuaishou: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    chatTransport: 'desktop_bridge',
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: '官方 API 同步商品、订单和售后事件；客服聊天通过桌面消息桥接入。'
  })
})

export function getChannelCapabilities(channel = '') {
  const normalized = String(channel || '').trim().toLowerCase()
  return { ...(CHANNEL_CAPABILITIES[normalized] || NO_CAPABILITIES) }
}
