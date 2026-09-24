const DEFAULT_CHANNEL_DEFINITIONS = Object.freeze([
  Object.freeze({ code: 'whatsapp', label: 'WhatsApp', adapterType: 'waha', scope: 'overseas', sort: 10 }),
  Object.freeze({ code: 'wechat', label: '微信小程序', adapterType: 'wechat_mini_program', scope: 'domestic', sort: 20 }),
  Object.freeze({ code: 'douyin', label: '抖音', adapterType: 'douyin_commerce', scope: 'domestic', sort: 30 }),
  Object.freeze({ code: 'pinduoduo', label: '拼多多', adapterType: 'pinduoduo_commerce', scope: 'domestic', sort: 40 }),
  Object.freeze({ code: 'taobao', label: '淘宝 / 千牛', adapterType: 'taobao_commerce', scope: 'domestic', sort: 50 }),
  Object.freeze({ code: 'alibaba1688', label: '1688', adapterType: 'alibaba1688_commerce', scope: 'domestic', sort: 60 }),
  Object.freeze({ code: 'xiaohongshu', label: '小红书', adapterType: 'xiaohongshu_commerce', scope: 'domestic', sort: 70 }),
  Object.freeze({ code: 'wechat_shop', label: '微信小店', adapterType: 'wechat_shop_commerce', scope: 'domestic', sort: 80 }),
  Object.freeze({ code: 'kuaishou', label: '快手小店', adapterType: 'kuaishou_commerce', scope: 'domestic', sort: 90 })
])

async function seedDefaultChannelDefinitions(sequelize) {
  for (const item of DEFAULT_CHANNEL_DEFINITIONS) {
    try {
      await sequelize.query(
        `INSERT INTO channel_definitions
           (code, label, adapter_type, knowledge_scope, knowledge_channels, sort_order, status, created_at, updated_at)
         SELECT :code, :label, :adapterType, :scope, JSON_ARRAY('all'), :sort, 'active', NOW(), NOW()
         WHERE NOT EXISTS (SELECT 1 FROM channel_definitions WHERE code = :code)`,
        { replacements: item }
      )
    } catch {
      // Ignore duplicate seed races.
    }
  }

  for (const [code, adapterType] of [
    ['douyin', 'douyin_commerce'],
    ['pinduoduo', 'pinduoduo_commerce'],
    ['taobao', 'taobao_commerce'],
    ['alibaba1688', 'alibaba1688_commerce'],
    ['xiaohongshu', 'xiaohongshu_commerce'],
    ['wechat_shop', 'wechat_shop_commerce'],
    ['kuaishou', 'kuaishou_commerce']
  ]) {
    await sequelize.query(
      `UPDATE channel_definitions
       SET adapter_type = :adapterType
       WHERE code = :code
         AND (adapter_type IS NULL OR adapter_type <> :adapterType)`,
      { replacements: { code, adapterType } }
    )
  }

  await sequelize.query(
    `UPDATE channel_definitions
     SET adapter_type = :adapterType,
         label = :label
     WHERE code = :code
       AND (adapter_type IS NULL OR adapter_type <> :adapterType OR label IS NULL OR label <> :label)`,
    {
      replacements: {
        code: 'wechat',
        label: '微信小程序',
        adapterType: 'wechat_mini_program'
      }
    }
  )
}

module.exports = { DEFAULT_CHANNEL_DEFINITIONS, seedDefaultChannelDefinitions }
