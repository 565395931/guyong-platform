const CAMPAIGN_BLUEPRINTS = [
  {
    id: 'new_product_launch',
    name: '新品首发',
    summary: '围绕新品亮点做首轮触达，先种草再转化。',
    goal: '提升新品认知和首单转化',
    type: 'dm',
    targetChannels: ['whatsapp', 'wechat', 'xiaohongshu'],
    targetTags: ['new_product', 'high_intent'],
    dailyLimit: 120,
    intervalSeconds: 30,
    sendTimeStart: '10:00',
    sendTimeEnd: '21:00',
    tone: 'direct',
    audience: ['新关注用户', '浏览未下单用户'],
    recommendedVideoTemplateId: 'product_showcase',
    scripts: [
      {
        content: 'Hi {name}，我们刚上新了{productName}，最值得先看的是{highlight1}。要不要我发你一个 30 秒版本？',
        mediaFileIds: []
      },
      {
        content: '如果你在意{benefit1}，我这边可以把功能点、案例和价格一起发给你。',
        mediaFileIds: []
      }
    ],
    notes: ['优先推高意向标签', '回复型用户优先进入二次触达']
  },
  {
    id: 'dormant_reactivation',
    name: '沉默唤醒',
    summary: '针对长时间未互动客户，用利益点和低门槛动作重新激活。',
    goal: '提升回访率和复购率',
    type: 'dm',
    targetChannels: ['whatsapp', 'wechat', 'kuaishou'],
    targetTags: ['dormant', 'repurchase'],
    dailyLimit: 80,
    intervalSeconds: 45,
    sendTimeStart: '11:00',
    sendTimeEnd: '20:30',
    tone: 'warm',
    audience: ['30 天未互动客户', '曾经咨询但未成交客户'],
    recommendedVideoTemplateId: 'promo_offer',
    scripts: [
      {
        content: '{name}，好久不见。我们最近给老客户准备了一次回访福利，{offer}，要不要我帮你留一份？',
        mediaFileIds: []
      },
      {
        content: '如果你最近刚好在看{productName}，我可以先发你一个简版对比和老客反馈。',
        mediaFileIds: []
      }
    ],
    notes: ['避免一次性推销', '先利益点后行动']
  },
  {
    id: 'comment_conversion',
    name: '评论转化',
    summary: '把评论区意向用户拉进私聊，用高响应话术完成承接。',
    goal: '提升评论区到私聊的转化',
    type: 'comment',
    targetChannels: ['douyin', 'xiaohongshu', 'kuaishou'],
    targetTags: ['comment', 'high_intent'],
    dailyLimit: 150,
    intervalSeconds: 20,
    sendTimeStart: '09:30',
    sendTimeEnd: '22:00',
    tone: 'friendly',
    audience: ['在评论区提问的用户', '点赞但未私信的用户'],
    recommendedVideoTemplateId: 'outreach_clip',
    scripts: [
      {
        content: '看到你刚刚在评论区问{topic}，我把{productName}的详细对比和案例单独发你。',
        mediaFileIds: []
      },
      {
        content: '如果你想对比{competitor}和{productName}，我可以直接给你一版简表，省得你自己翻。',
        mediaFileIds: []
      }
    ],
    notes: ['先回应问题，再给行动入口', '缩短从公域到私域的链路']
  },
  {
    id: 'keyword_capture',
    name: '关键词承接',
    summary: '承接主动搜索、主动咨询和关键词触发流量。',
    goal: '把主动意向尽快转成会话和订单',
    type: 'keyword',
    targetChannels: ['whatsapp', 'wechat', 'taobao', 'alibaba1688'],
    targetTags: ['keyword', 'consulting'],
    dailyLimit: 200,
    intervalSeconds: 15,
    sendTimeStart: '09:00',
    sendTimeEnd: '23:00',
    tone: 'professional',
    audience: ['主动搜索用户', '咨询过价格和交期的用户'],
    recommendedVideoTemplateId: 'comparison_explainer',
    scripts: [
      {
        content: '你好，看到你刚刚询问{topic}，我先把{productName}的核心参数和报价区间发你。',
        mediaFileIds: []
      },
      {
        content: '如果你想更快对比，我可以直接给你一版「功能 / 价格 / 交期」三列的简表。',
        mediaFileIds: []
      }
    ],
    notes: ['关键词命中后 1 分钟内响应', '用简表替代长篇解释']
  },
  {
    id: 'repeat_purchase',
    name: '复购提升',
    summary: '围绕老客权益、会员机制和搭配购买促进复购。',
    goal: '提升复购率和客单价',
    type: 'dm',
    targetChannels: ['whatsapp', 'wechat', 'wechat_shop'],
    targetTags: ['repurchase', 'vip'],
    dailyLimit: 100,
    intervalSeconds: 40,
    sendTimeStart: '10:30',
    sendTimeEnd: '21:30',
    tone: 'care',
    audience: ['购买过一次的老客', '高价值会员'],
    recommendedVideoTemplateId: 'testimonial_roundup',
    scripts: [
      {
        content: '{name}，你上次买的{productName}最近刚好有一波配套升级，我把适合你的组合发你看看。',
        mediaFileIds: []
      },
      {
        content: '老客专属权益本周还在，给你留一份{offer}，如果合适我直接帮你开单。',
        mediaFileIds: []
      }
    ],
    notes: ['强调老客权益', '优先推荐组合和加购']
  },
  {
    id: 'lead_nurture',
    name: '线索培育',
    summary: '通过分阶段内容把潜在线索慢慢推向高意向。',
    goal: '提升线索质量和成交率',
    type: 'dm',
    targetChannels: ['whatsapp', 'wechat', 'alibaba1688'],
    targetTags: ['lead', 'warm'],
    dailyLimit: 140,
    intervalSeconds: 50,
    sendTimeStart: '10:00',
    sendTimeEnd: '20:00',
    tone: 'educational',
    audience: ['已咨询但未下单用户', '刚完成首次互动的潜在客户'],
    recommendedVideoTemplateId: 'brand_story',
    scripts: [
      {
        content: '我给你整理了一版{productName}的使用场景和选型逻辑，先让你少踩坑。',
        mediaFileIds: []
      },
      {
        content: '如果你愿意，我可以接着把{productName}的案例、报价和交付节奏一起发你。',
        mediaFileIds: []
      }
    ],
    notes: ['先教育再转化', '用连续内容建立信任']
  }
]

const VIDEO_TEMPLATES = [
  {
    id: 'product_showcase',
    name: '产品展示片',
    summary: '适合新品首发和产品详情页，突出卖点、场景和行动入口。',
    durationSeconds: 18,
    aspectRatio: '9:16',
    tone: 'direct',
    defaultBgm: 'energetic',
    recommendedChannels: ['douyin', 'kuaishou', 'xiaohongshu', 'whatsapp'],
    recommendedCampaignBlueprintIds: ['new_product_launch'],
    defaultAudience: '新关注用户 / 高意向咨询用户',
    defaultKeyPoints: ['核心卖点', '使用场景', '购买理由'],
    defaultCallToAction: '立即咨询，获取完整版资料',
    sceneBlueprints: [
      {
        label: '开场钩子',
        durationSeconds: 3,
        voiceoverTemplate: '{title}，先看最关键的一个卖点：{keyPoint1}',
        onScreenTemplate: '{title}',
        visualTemplate: '主视觉 + 关键卖点',
        assetRole: 'hero'
      },
      {
        label: '核心卖点',
        durationSeconds: 5,
        voiceoverTemplate: '{keyPoint2}',
        onScreenTemplate: '{keyPoint1}',
        visualTemplate: '功能细节 / 特写镜头',
        assetRole: 'detail'
      },
      {
        label: '场景证明',
        durationSeconds: 5,
        voiceoverTemplate: '{proofLine}',
        onScreenTemplate: '{proofLine}',
        visualTemplate: '使用场景 / 对比画面',
        assetRole: 'proof'
      },
      {
        label: '行动召唤',
        durationSeconds: 5,
        voiceoverTemplate: '{cta}',
        onScreenTemplate: '{cta}',
        visualTemplate: '品牌收口 + 下单引导',
        assetRole: 'cta'
      }
    ]
  },
  {
    id: 'promo_offer',
    name: '促销转化片',
    summary: '适合限时优惠、老客唤醒和大促节点，强调利益点和下单动作。',
    durationSeconds: 15,
    aspectRatio: '9:16',
    tone: 'urgent',
    defaultBgm: 'driving',
    recommendedChannels: ['whatsapp', 'wechat', 'douyin', 'wechat_shop'],
    recommendedCampaignBlueprintIds: ['dormant_reactivation', 'repeat_purchase'],
    defaultAudience: '老客 / 沉默客户 / 已加购用户',
    defaultKeyPoints: ['限时优惠', '优惠门槛', '即刻行动'],
    defaultCallToAction: '现在下单，立享限时优惠',
    sceneBlueprints: [
      {
        label: '优惠钩子',
        durationSeconds: 3,
        voiceoverTemplate: '现在有一波{offer}，只给最适合的人。',
        onScreenTemplate: '{offer}',
        visualTemplate: '价格锤点 + 倒计时',
        assetRole: 'hero'
      },
      {
        label: '利益说明',
        durationSeconds: 4,
        voiceoverTemplate: '{keyPoint1}，直接帮你省掉犹豫成本。',
        onScreenTemplate: '{keyPoint1}',
        visualTemplate: '利益点拆解',
        assetRole: 'detail'
      },
      {
        label: '信任补强',
        durationSeconds: 4,
        voiceoverTemplate: '{proofLine}',
        onScreenTemplate: '{proofLine}',
        visualTemplate: '评价 / 案例 / 口碑',
        assetRole: 'proof'
      },
      {
        label: '收口成交',
        durationSeconds: 4,
        voiceoverTemplate: '{cta}',
        onScreenTemplate: '{cta}',
        visualTemplate: '按钮引导 / 购买入口',
        assetRole: 'cta'
      }
    ]
  },
  {
    id: 'testimonial_roundup',
    name: '口碑合集片',
    summary: '用真实评价、案例和复购反馈建立信任，适合老客与中后段线索。',
    durationSeconds: 20,
    aspectRatio: '9:16',
    tone: 'trustworthy',
    defaultBgm: 'warm',
    recommendedChannels: ['wechat', 'whatsapp', 'xiaohongshu', 'wechat_shop'],
    recommendedCampaignBlueprintIds: ['repeat_purchase', 'lead_nurture'],
    defaultAudience: '老客 / 中后段线索 / 对比型用户',
    defaultKeyPoints: ['真实反馈', '使用前后变化', '复购理由'],
    defaultCallToAction: '回复关键词，领取案例合集',
    sceneBlueprints: [
      {
        label: '口碑开场',
        durationSeconds: 4,
        voiceoverTemplate: '先看几个真实反馈，答案比我们自己说更有用。',
        onScreenTemplate: '真实反馈',
        visualTemplate: '评价快切 / 用户截图',
        assetRole: 'hero'
      },
      {
        label: '案例展示',
        durationSeconds: 5,
        voiceoverTemplate: '{keyPoint1}',
        onScreenTemplate: '{keyPoint1}',
        visualTemplate: '案例前后对比',
        assetRole: 'detail'
      },
      {
        label: '复购理由',
        durationSeconds: 5,
        voiceoverTemplate: '{proofLine}',
        onScreenTemplate: '{proofLine}',
        visualTemplate: '复购客户 / 场景镜头',
        assetRole: 'proof'
      },
      {
        label: '行动召唤',
        durationSeconds: 6,
        voiceoverTemplate: '{cta}',
        onScreenTemplate: '{cta}',
        visualTemplate: '权益入口 / 联系方式',
        assetRole: 'cta'
      }
    ]
  },
  {
    id: 'brand_story',
    name: '品牌故事片',
    summary: '用品牌价值、研发历程和长期承诺建立信任。',
    durationSeconds: 25,
    aspectRatio: '9:16',
    tone: 'emotional',
    defaultBgm: 'cinematic',
    recommendedChannels: ['xiaohongshu', 'douyin', 'wechat', 'alibaba1688'],
    recommendedCampaignBlueprintIds: ['lead_nurture'],
    defaultAudience: '首次了解品牌的人',
    defaultKeyPoints: ['为什么做这件事', '和别人不一样的地方', '长期承诺'],
    defaultCallToAction: '了解更多品牌故事',
    sceneBlueprints: [
      {
        label: '品牌开场',
        durationSeconds: 5,
        voiceoverTemplate: '我们做{productName}，不是为了快，而是为了更稳。',
        onScreenTemplate: '{title}',
        visualTemplate: '品牌氛围镜头',
        assetRole: 'hero'
      },
      {
        label: '价值观',
        durationSeconds: 7,
        voiceoverTemplate: '{keyPoint1}',
        onScreenTemplate: '{keyPoint1}',
        visualTemplate: '研发 / 生产 / 团队',
        assetRole: 'detail'
      },
      {
        label: '差异点',
        durationSeconds: 7,
        voiceoverTemplate: '{proofLine}',
        onScreenTemplate: '{keyPoint2}',
        visualTemplate: '对比画面 / 细节特写',
        assetRole: 'proof'
      },
      {
        label: '收尾',
        durationSeconds: 6,
        voiceoverTemplate: '{cta}',
        onScreenTemplate: '{cta}',
        visualTemplate: '品牌口号 / 联系入口',
        assetRole: 'cta'
      }
    ]
  },
  {
    id: 'comparison_explainer',
    name: '对比说明片',
    summary: '适合 FAQ、竞品对比和技术讲解，让客户更快做决定。',
    durationSeconds: 20,
    aspectRatio: '9:16',
    tone: 'analytical',
    defaultBgm: 'neutral',
    recommendedChannels: ['whatsapp', 'wechat', 'taobao', 'alibaba1688'],
    recommendedCampaignBlueprintIds: ['keyword_capture'],
    defaultAudience: '正在对比方案的用户',
    defaultKeyPoints: ['功能对比', '成本对比', '交付对比'],
    defaultCallToAction: '立即咨询，获取完整对比表',
    sceneBlueprints: [
      {
        label: '问题引入',
        durationSeconds: 4,
        voiceoverTemplate: '很多人在选{productName}时，最纠结的是怎么选。',
        onScreenTemplate: '{title}',
        visualTemplate: '问题 / 场景引入',
        assetRole: 'hero'
      },
      {
        label: '对比维度',
        durationSeconds: 6,
        voiceoverTemplate: '{keyPoint1}，先看这条最关键的差异。',
        onScreenTemplate: '{keyPoint1}',
        visualTemplate: '对比表格 / 参数卡片',
        assetRole: 'detail'
      },
      {
        label: '结论输出',
        durationSeconds: 5,
        voiceoverTemplate: '{proofLine}',
        onScreenTemplate: '{keyPoint2}',
        visualTemplate: '结论总结 / 选型建议',
        assetRole: 'proof'
      },
      {
        label: '咨询入口',
        durationSeconds: 5,
        voiceoverTemplate: '{cta}',
        onScreenTemplate: '{cta}',
        visualTemplate: '咨询按钮 / 简表下载',
        assetRole: 'cta'
      }
    ]
  },
  {
    id: 'outreach_clip',
    name: '私信承接片',
    summary: '适合评论区引流和主动咨询，重点是快速回应、短句承接和下一步动作。',
    durationSeconds: 12,
    aspectRatio: '9:16',
    tone: 'friendly',
    defaultBgm: 'light',
    recommendedChannels: ['douyin', 'kuaishou', 'xiaohongshu', 'whatsapp'],
    recommendedCampaignBlueprintIds: ['comment_conversion'],
    defaultAudience: '评论区提问用户',
    defaultKeyPoints: ['快速回应', '简洁说明', '下一步动作'],
    defaultCallToAction: '回复关键词，马上拿资料',
    sceneBlueprints: [
      {
        label: '快速回应',
        durationSeconds: 3,
        voiceoverTemplate: '你刚刚问到的{topic}，我直接给你答案。',
        onScreenTemplate: '{topic}',
        visualTemplate: '评论区回复快切',
        assetRole: 'hero'
      },
      {
        label: '简洁说明',
        durationSeconds: 3,
        voiceoverTemplate: '{keyPoint1}',
        onScreenTemplate: '{keyPoint1}',
        visualTemplate: '一句话说明',
        assetRole: 'detail'
      },
      {
        label: '下一步动作',
        durationSeconds: 3,
        voiceoverTemplate: '{proofLine}',
        onScreenTemplate: '{proofLine}',
        visualTemplate: '私信 / 联系方式引导',
        assetRole: 'proof'
      },
      {
        label: '回复召唤',
        durationSeconds: 3,
        voiceoverTemplate: '{cta}',
        onScreenTemplate: '{cta}',
        visualTemplate: '回复关键词',
        assetRole: 'cta'
      }
    ]
  }
]

function clone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeString(value) {
  return String(value == null ? '' : value).trim()
}

function normalizeStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(item => normalizeString(item))
    .filter(Boolean))]
}

function parseFlexibleList(value) {
  if (Array.isArray(value)) return normalizeStrings(value)
  if (value == null || value === '') return []
  if (typeof value === 'string') {
    return normalizeStrings(value.split(/[\n,，;；]+/g))
  }
  return normalizeStrings([value])
}

function normalizePositiveInts(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0))]
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function renderTemplate(template, context = {}) {
  return String(template || '').replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const key = String(rawKey || '').trim()
    return Object.prototype.hasOwnProperty.call(context, key)
      ? String(context[key] ?? '')
      : match
  })
}

function summarizeMediaFile(file = {}) {
  return {
    id: file.id,
    originalName: file.originalName || file.original_name || '',
    displayName: file.displayName || file.display_name || file.originalName || file.original_name || '',
    mediaType: file.mediaType || file.media_type || 'file',
    mimeType: file.mimeType || file.mime_type || '',
    size: Number(file.size || 0),
    url: file.url || '',
    fullUrl: file.fullUrl || file.full_url || file.url || ''
  }
}

function attachBlueprintDraft(blueprint = {}, videoTemplateMap = new Map()) {
  const recommendedVideoTemplate = videoTemplateMap.get(blueprint.recommendedVideoTemplateId) || null
  return {
    id: blueprint.id,
    name: blueprint.name,
    summary: blueprint.summary,
    goal: blueprint.goal,
    type: blueprint.type,
    targetChannels: clone(blueprint.targetChannels || []),
    targetTags: clone(blueprint.targetTags || []),
    dailyLimit: blueprint.dailyLimit,
    intervalSeconds: blueprint.intervalSeconds,
    sendTimeStart: blueprint.sendTimeStart,
    sendTimeEnd: blueprint.sendTimeEnd,
    tone: blueprint.tone,
    audience: clone(blueprint.audience || []),
    recommendedVideoTemplateId: blueprint.recommendedVideoTemplateId,
    recommendedVideoTemplate: recommendedVideoTemplate
      ? {
          id: recommendedVideoTemplate.id,
          name: recommendedVideoTemplate.name,
          summary: recommendedVideoTemplate.summary
        }
      : null,
    scripts: clone(blueprint.scripts || []),
    notes: clone(blueprint.notes || []),
    draft: {
      name: blueprint.name,
      type: blueprint.type,
      targetChannels: clone(blueprint.targetChannels || []),
      targetTags: clone(blueprint.targetTags || []),
      targetUserIds: [],
      scripts: clone(blueprint.scripts || []),
      accountIds: [],
      dailyLimit: blueprint.dailyLimit,
      intervalSeconds: blueprint.intervalSeconds,
      sendTimeStart: blueprint.sendTimeStart,
      sendTimeEnd: blueprint.sendTimeEnd
    }
  }
}

function attachVideoDraft(template = {}) {
  return {
    id: template.id,
    name: template.name,
    summary: template.summary,
    durationSeconds: template.durationSeconds,
    aspectRatio: template.aspectRatio,
    tone: template.tone,
    defaultBgm: template.defaultBgm,
    recommendedChannels: clone(template.recommendedChannels || []),
    recommendedCampaignBlueprintIds: clone(template.recommendedCampaignBlueprintIds || []),
    defaultAudience: template.defaultAudience,
    defaultKeyPoints: clone(template.defaultKeyPoints || []),
    defaultCallToAction: template.defaultCallToAction,
    sceneBlueprints: clone(template.sceneBlueprints || []),
    draft: {
      templateId: template.id,
      title: template.name,
      productName: '',
      audience: template.defaultAudience,
      tone: template.tone,
      bgm: template.defaultBgm,
      durationSeconds: template.durationSeconds,
      keyPoints: clone(template.defaultKeyPoints || []),
      callToAction: template.defaultCallToAction,
      mediaFileIds: [],
      script: ''
    }
  }
}

function getVideoTemplateMap() {
  return new Map(VIDEO_TEMPLATES.map(template => [template.id, template]))
}

function getCampaignBlueprintMap() {
  return new Map(CAMPAIGN_BLUEPRINTS.map(blueprint => [blueprint.id, blueprint]))
}

function getCampaignBlueprints(filters = {}) {
  const videoTemplateMap = getVideoTemplateMap()
  const channelFilter = normalizeStrings(filters.channel ? [filters.channel] : [])
  const typeFilter = normalizeString(filters.type).toLowerCase()

  return CAMPAIGN_BLUEPRINTS
    .filter(blueprint => {
      if (typeFilter && blueprint.type !== typeFilter) return false
      if (channelFilter.length === 0) return true
      const blueprintChannels = new Set((blueprint.targetChannels || []).map(channel => String(channel).toLowerCase()))
      return channelFilter.some(channel => blueprintChannels.has(channel))
    })
    .map(blueprint => attachBlueprintDraft(clone(blueprint), videoTemplateMap))
}

function getCampaignBlueprint(blueprintId) {
  const blueprint = getCampaignBlueprintMap().get(String(blueprintId || '').trim())
  if (!blueprint) return null
  return attachBlueprintDraft(clone(blueprint), getVideoTemplateMap())
}

function buildCampaignBlueprintDraft(blueprintId, overrides = {}) {
  const blueprint = getCampaignBlueprint(blueprintId)
  if (!blueprint) return null

  const draft = {
    name: normalizeString(overrides.name) || blueprint.name,
    type: blueprint.type,
    targetChannels: normalizeStrings(overrides.targetChannels).length > 0
      ? normalizeStrings(overrides.targetChannels)
      : clone(blueprint.draft.targetChannels),
    targetTags: normalizeStrings(overrides.targetTags).length > 0
      ? normalizeStrings(overrides.targetTags)
      : clone(blueprint.draft.targetTags),
    targetUserIds: parseFlexibleList(overrides.targetUserIds),
    scripts: Array.isArray(overrides.scripts) && overrides.scripts.length > 0
      ? overrides.scripts.map(script => ({
          content: normalizeString(script?.content),
          mediaFileIds: normalizeStrings(script?.mediaFileIds)
        })).filter(script => script.content)
      : clone(blueprint.draft.scripts),
    accountIds: normalizePositiveInts(overrides.accountIds),
    dailyLimit: Number.isFinite(Number(overrides.dailyLimit))
      ? clampNumber(overrides.dailyLimit, 1, 1000, blueprint.draft.dailyLimit)
      : blueprint.draft.dailyLimit,
    intervalSeconds: Number.isFinite(Number(overrides.intervalSeconds))
      ? clampNumber(overrides.intervalSeconds, 5, 3600, blueprint.draft.intervalSeconds)
      : blueprint.draft.intervalSeconds,
    sendTimeStart: normalizeString(overrides.sendTimeStart) || blueprint.draft.sendTimeStart,
    sendTimeEnd: normalizeString(overrides.sendTimeEnd) || blueprint.draft.sendTimeEnd
  }

  return {
    blueprintId,
    blueprint,
    draft
  }
}

function getVideoTemplates(filters = {}) {
  const channelFilter = normalizeStrings(filters.channel ? [filters.channel] : [])

  return VIDEO_TEMPLATES
    .filter(template => {
      if (channelFilter.length === 0) return true
      const channels = new Set((template.recommendedChannels || []).map(channel => String(channel).toLowerCase()))
      return channelFilter.some(channel => channels.has(channel))
    })
    .map(template => attachVideoDraft(clone(template)))
}

function getVideoTemplate(templateId) {
  const template = getVideoTemplateMap().get(String(templateId || '').trim())
  if (!template) return null
  return attachVideoDraft(clone(template))
}

function normalizeVideoGenerationInput(input = {}) {
  const templateId = normalizeString(input.templateId)
  if (!templateId) return { error: '请先选择视频模板' }

  const title = normalizeString(input.title)
  if (!title) return { error: '视频标题不能为空' }
  if (title.length > 120) return { error: '视频标题不能超过120个字符' }

  const productName = normalizeString(input.productName)
  const audience = normalizeString(input.audience)
  const tone = normalizeString(input.tone) || 'balanced'
  const bgm = normalizeString(input.bgm) || null
  const callToAction = normalizeString(input.callToAction || input.cta)
  const script = normalizeString(input.script)
  const keyPoints = parseFlexibleList(input.keyPoints)
  const mediaFileIds = normalizeStrings(input.mediaFileIds)
  const durationSeconds = clampNumber(input.durationSeconds, 6, 120, null)
  const channel = normalizeString(input.channel).toLowerCase() || null

  return {
    data: {
      templateId,
      title,
      productName,
      audience,
      tone,
      bgm,
      callToAction,
      script,
      keyPoints,
      mediaFileIds,
      durationSeconds,
      channel,
      referenceNotes: normalizeString(input.referenceNotes)
    }
  }
}

function buildSceneContext({ input = {}, template = {}, mediaFiles = [] } = {}) {
  const keyPoints = input.keyPoints || []
  const scriptSegments = parseFlexibleList(input.script)
  const firstKeyPoint = keyPoints[0] || template.defaultKeyPoints?.[0] || ''
  const secondKeyPoint = keyPoints[1] || template.defaultKeyPoints?.[1] || firstKeyPoint
  const thirdKeyPoint = keyPoints[2] || template.defaultKeyPoints?.[2] || secondKeyPoint
  const productName = input.productName || template.name
  const title = input.title || template.name
  const audience = input.audience || template.defaultAudience || ''
  const cta = input.callToAction || template.defaultCallToAction || '立即咨询'
  const proofLine = scriptSegments[1] || scriptSegments[0] || `${productName} 更适合关注效率和转化的人。`
  const topic = firstKeyPoint || secondKeyPoint || productName
  const offer = secondKeyPoint || cta
  const visualHint = input.referenceNotes || template.summary || ''

  return {
    title,
    productName,
    audience,
    cta,
    tone: input.tone || template.tone || 'balanced',
    bgm: input.bgm || template.defaultBgm || 'neutral',
    durationSeconds: input.durationSeconds || template.durationSeconds || 15,
    keyPoint1: firstKeyPoint || `${productName} 的核心卖点`,
    keyPoint2: secondKeyPoint || `${productName} 的第二层价值`,
    keyPoint3: thirdKeyPoint || `${productName} 的第三个差异点`,
    proofLine,
    topic,
    offer,
    visualHint,
    scriptSegments,
    mediaFiles: mediaFiles.map(summarizeMediaFile)
  }
}

function selectSceneAsset(mediaFiles = [], sceneIndex = 0) {
  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) return null
  return summarizeMediaFile(mediaFiles[sceneIndex % mediaFiles.length])
}

function buildVideoGenerationPlan({ template, input = {}, mediaFiles = [], now = () => new Date() } = {}) {
  if (!template) {
    throw new Error('视频模板不存在')
  }

  const sceneContext = buildSceneContext({ input, template, mediaFiles })
  const scenes = (template.sceneBlueprints || []).map((scene, index) => {
    const context = {
      ...sceneContext,
      sceneIndex: index + 1,
      sceneLabel: scene.label,
      sceneDuration: scene.durationSeconds
    }

    return {
      index: index + 1,
      label: scene.label,
      durationSeconds: scene.durationSeconds,
      objective: scene.visualTemplate,
      voiceover: renderTemplate(scene.voiceoverTemplate, context),
      onScreenText: renderTemplate(scene.onScreenTemplate, context),
      visualDirection: renderTemplate(scene.visualTemplate, context),
      assetRole: scene.assetRole,
      mediaAsset: selectSceneAsset(mediaFiles, index),
      transition: index === 0 ? 'intro' : 'cut'
    }
  })

  const hashtags = [
    `#${sceneContext.productName || template.name}`,
    ...(template.recommendedChannels || []).slice(0, 2).map(channel => `#${channel}`),
    ...(sceneContext.keyPoint1 ? [`#${sceneContext.keyPoint1}`] : []),
    ...(sceneContext.keyPoint2 ? [`#${sceneContext.keyPoint2}`] : [])
  ]
    .map(tag => tag.replace(/\s+/g, ''))
    .filter(Boolean)

  const captionPieces = [
    sceneContext.title,
    sceneContext.productName ? `${sceneContext.productName} 重点拆解` : '',
    sceneContext.scriptSegments[0] || sceneContext.keyPoint1,
    sceneContext.cta
  ].map(part => normalizeString(part)).filter(Boolean)

  return {
    templateId: template.id,
    templateName: template.name,
    summary: template.summary,
    title: sceneContext.title,
    productName: sceneContext.productName,
    audience: sceneContext.audience,
    tone: sceneContext.tone,
    bgm: sceneContext.bgm,
    durationSeconds: sceneContext.durationSeconds,
    keyPoints: [sceneContext.keyPoint1, sceneContext.keyPoint2, sceneContext.keyPoint3].filter(Boolean),
    script: sceneContext.scriptSegments.join('\n'),
    cta: sceneContext.cta,
    scenes,
    mediaAssets: sceneContext.mediaFiles,
    assetPlan: {
      total: sceneContext.mediaFiles.length,
      imageCount: sceneContext.mediaFiles.filter(item => item.mediaType === 'image').length,
      videoCount: sceneContext.mediaFiles.filter(item => item.mediaType === 'video').length,
      primaryAssetIds: sceneContext.mediaFiles.slice(0, 2).map(item => item.id)
    },
    caption: captionPieces.join('｜'),
    hashtags,
    bridge: {
      recommendedCampaignBlueprintIds: clone(template.recommendedCampaignBlueprintIds || []),
      recommendedChannels: clone(template.recommendedChannels || [])
    },
    renderSpec: {
      aspectRatio: template.aspectRatio,
      durationSeconds: sceneContext.durationSeconds,
      bgm: sceneContext.bgm,
      tone: sceneContext.tone,
      sceneCount: scenes.length,
      mediaFileIds: sceneContext.mediaFiles.map(item => item.id)
    },
    publishChecklist: [
      '检查封面图和首帧',
      '确认字幕与标题一致',
      '准备评论区置顶回复',
      '补充落地页或私信入口'
    ],
    generatedAt: (() => {
      if (typeof now === 'function') return now().toISOString()
      if (now instanceof Date) return now.toISOString()
      return new Date(now || Date.now()).toISOString()
    })()
  }
}

module.exports = {
  CAMPAIGN_BLUEPRINTS,
  VIDEO_TEMPLATES,
  getCampaignBlueprints,
  getCampaignBlueprint,
  buildCampaignBlueprintDraft,
  getVideoTemplates,
  getVideoTemplate,
  normalizeVideoGenerationInput,
  buildVideoGenerationPlan,
  // exported for tests / future reuse
  parseFlexibleList,
  normalizeStrings,
  normalizePositiveInts,
  renderTemplate,
  summarizeMediaFile
}
