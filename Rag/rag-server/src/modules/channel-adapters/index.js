/**
 * 渠道适配器注册中心
 *
 * 管理所有渠道适配器实例（单例），提供 getAdapter 方法。
 * 新增渠道时，在此注册即可。
 */

const WahaAdapter = require('./whatsapp-waha/wahaAdapter')
const DouyinCommerceAdapter = require('./douyin-commerce/douyinAdapter')
const PinduoduoCommerceAdapter = require('./pinduoduo-commerce/pinduoduoAdapter')
const TaobaoCommerceAdapter = require('./taobao-commerce/taobaoAdapter')
const Alibaba1688CommerceAdapter = require('./alibaba1688-commerce/alibaba1688Adapter')
const XiaohongshuCommerceAdapter = require('./xiaohongshu-commerce/xiaohongshuAdapter')
const WechatShopCommerceAdapter = require('./wechat-shop-commerce/wechatShopAdapter')
const KuaishouCommerceAdapter = require('./kuaishou-commerce/kuaishouAdapter')

// 适配器注册表：adapterType → 适配器实例
const adapterRegistry = {}
const PROJECTION_MAPPER_CHANNELS = new Set(['pinduoduo', 'taobao', 'alibaba1688'])

function validateProjectionMappers(value) {
  if (value === undefined) return Object.freeze({})
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('orderProjectionMappers must be an object')
  }
  const result = {}
  for (const [channel, mapper] of Object.entries(value)) {
    if (!PROJECTION_MAPPER_CHANNELS.has(channel)) {
      throw new TypeError(`Unsupported order projection mapper channel: ${channel}`)
    }
    if (typeof mapper !== 'function') {
      throw new TypeError(`Order projection mapper for ${channel} must be a function`)
    }
    result[channel] = mapper
  }
  return Object.freeze(result)
}

/**
 * 初始化并注册所有适配器
 */
function initAdapters({ orderProjectionMappers } = {}) {
  const mappers = validateProjectionMappers(orderProjectionMappers)
  const wahaAdapter = new WahaAdapter()
  adapterRegistry['waha'] = wahaAdapter
  adapterRegistry['douyin_commerce'] = new DouyinCommerceAdapter()
  adapterRegistry['pinduoduo_commerce'] = new PinduoduoCommerceAdapter({ orderProjectionMapper: mappers.pinduoduo })
  adapterRegistry['taobao_commerce'] = new TaobaoCommerceAdapter({ orderProjectionMapper: mappers.taobao })
  adapterRegistry['alibaba1688_commerce'] = new Alibaba1688CommerceAdapter({ orderProjectionMapper: mappers.alibaba1688 })
  adapterRegistry['xiaohongshu_commerce'] = new XiaohongshuCommerceAdapter()
  adapterRegistry['wechat_shop_commerce'] = new WechatShopCommerceAdapter()
  adapterRegistry['kuaishou_commerce'] = new KuaishouCommerceAdapter()

  // ===== 未来渠道在此注册 =====
  // adapterRegistry['waaku'] = new WaakuAdapter()
  // adapterRegistry['douyin'] = new DouyinAdapter()

  console.log('[ChannelAdapters] 适配器注册完成:', Object.keys(adapterRegistry))
}

/**
 * 根据 adapterType 获取适配器
 * @param {string} adapterType
 * @returns {BaseAdapter|null}
 */
function getAdapter(adapterType) {
  const adapter = adapterRegistry[adapterType]
  if (!adapter) {
    console.warn(`[ChannelAdapters] 未找到适配器: ${adapterType}`)
    return null
  }
  return adapter
}

/**
 * 根据 channel 获取适配器（目前 whatsapp → waha）
 * @param {string} channel
 * @returns {BaseAdapter|null}
 */
function getAdapterByChannel(channel) {
  const channelMap = {
    whatsapp: 'waha',
    douyin: 'douyin_commerce',
    pinduoduo: 'pinduoduo_commerce',
    taobao: 'taobao_commerce',
    alibaba1688: 'alibaba1688_commerce',
    xiaohongshu: 'xiaohongshu_commerce',
    wechat_shop: 'wechat_shop_commerce',
    kuaishou: 'kuaishou_commerce'
    // douyin: 'douyin',
    // wechat: 'wechat'
  }
  const adapterType = channelMap[channel]
  return adapterType ? getAdapter(adapterType) : null
}

module.exports = {
  initAdapters,
  getAdapter,
  getAdapterByChannel
}
