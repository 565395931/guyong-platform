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
    limitation: '抖店开放平台暂未提供飞鸽客服消息收发 API'
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
    limitation: '淘宝公开服务端 API 不提供本独立网页系统可用的买家客服聊天收发能力，只同步订单退款并保留 buyer_open_uid/ouid'
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
    limitation: 'Official APIs provide commerce events; customer-service chat uses the desktop bridge.'
  }),
  wechat_shop: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    chatTransport: 'desktop_bridge',
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: 'Official APIs provide commerce events; customer-service chat uses the desktop bridge.'
  }),
  kuaishou: Object.freeze({
    customerMessagesIn: false,
    customerMessagesOut: false,
    chatTransport: 'desktop_bridge',
    orderEvents: true,
    afterSalesEvents: true,
    productEvents: true,
    requiresPublicCallback: true,
    limitation: 'Official APIs provide commerce events; customer-service chat uses the desktop bridge.'
  })
})

function getChannelCapabilities(channel = '') {
  const normalized = String(channel || '').trim().toLowerCase()
  return { ...(CHANNEL_CAPABILITIES[normalized] || NO_CAPABILITIES) }
}

module.exports = { getChannelCapabilities }
