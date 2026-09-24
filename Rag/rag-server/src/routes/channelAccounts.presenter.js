function isWahaAccount(account = {}) {
  return String(account.adapter_type || '').trim().toLowerCase() === 'waha'
}

function isDouyinAccount(account = {}) {
  return String(account.channel || '').trim().toLowerCase() === 'douyin' ||
    String(account.adapter_type || '').trim().toLowerCase() === 'douyin_commerce'
}

function isPinduoduoAccount(account = {}) {
  return String(account.channel || '').trim().toLowerCase() === 'pinduoduo' ||
    String(account.adapter_type || '').trim().toLowerCase() === 'pinduoduo_commerce'
}

function isTaobaoAccount(account = {}) {
  return String(account.channel || '').trim().toLowerCase() === 'taobao' ||
    String(account.adapter_type || '').trim().toLowerCase() === 'taobao_commerce'
}

function isAlibaba1688Account(account = {}) {
  return String(account.channel || '').trim().toLowerCase() === 'alibaba1688' ||
    String(account.adapter_type || '').trim().toLowerCase() === 'alibaba1688_commerce'
}

function isWechatMiniProgramAccount(account = {}) {
  return String(account.channel || '').trim().toLowerCase() === 'wechat' ||
    String(account.adapter_type || '').trim().toLowerCase() === 'wechat_mini_program'
}

function matchesCommerceAccount(account, channel, adapterType) {
  return String(account.channel || '').trim().toLowerCase() === channel ||
    String(account.adapter_type || '').trim().toLowerCase() === adapterType
}

function maskIdentifier(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  if (text.length <= 4) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}${'*'.repeat(text.length - 4)}`
}

function maskMallId(value) {
  const mallId = typeof value === 'string' ? value.trim() : ''
  if (!mallId) return null
  if (mallId.length <= 4) return '*'.repeat(mallId.length)
  return `${'*'.repeat(mallId.length - 4)}${mallId.slice(-4)}`
}

function deletePinduoduoCredentials(result) {
  for (const field of [
    'config',
    'clientId',
    'clientSecret',
    'accessToken',
    'mallId',
    'client_id',
    'client_secret',
    'access_token',
    'mall_id'
  ]) delete result[field]
}

function addPinduoduoCredentialSummary(result, parsePinduoduoConfig) {
  let config = {}
  try {
    config = typeof parsePinduoduoConfig === 'function'
      ? parsePinduoduoConfig(result.config, `accountId=${result.id}`)
      : {}
  } catch {
    config = {}
  }
  result.credentialStatus = ['clientId', 'clientSecret', 'accessToken', 'mallId'].every(field =>
    typeof config[field] === 'string' && Boolean(config[field].trim())
  ) ? 'configured' : 'incomplete'
  result.mallIdMask = maskMallId(config.mallId)
  deletePinduoduoCredentials(result)
}

function maskSellerNick(value) {
  const characters = Array.from(typeof value === 'string' ? value.trim() : '')
  if (!characters.length) return null
  if (characters.length <= 2) return '*'.repeat(characters.length)
  return `${characters[0]}${'*'.repeat(characters.length - 2)}${characters.at(-1)}`
}

function deleteTaobaoCredentials(result) {
  for (const field of [
    'config',
    'appKey',
    'appSecret',
    'sessionKey',
    'sellerNick',
    'app_key',
    'app_secret',
    'session_key',
    'seller_nick'
  ]) delete result[field]
}

function addTaobaoCredentialSummary(result, parseTaobaoConfig) {
  let config = {}
  try {
    config = typeof parseTaobaoConfig === 'function'
      ? parseTaobaoConfig(result.config, `accountId=${result.id}`)
      : {}
  } catch {
    config = {}
  }
  result.credentialStatus = ['appKey', 'appSecret', 'sessionKey', 'sellerNick'].every(field =>
    typeof config[field] === 'string' && Boolean(config[field].trim())
  ) ? 'configured' : 'incomplete'
  result.sellerNickMask = maskSellerNick(config.sellerNick)
  deleteTaobaoCredentials(result)
}

function maskSellerMemberId(value) {
  const memberId = typeof value === 'string' ? value.trim() : ''
  if (!memberId) return null
  if (memberId.length <= 8) return '*'.repeat(memberId.length)
  return `${memberId.slice(0, 4)}${'*'.repeat(6)}${memberId.slice(-4)}`
}

function deleteAlibaba1688Credentials(result) {
  for (const field of [
    'config',
    'appKey',
    'appSecret',
    'accessToken',
    'sellerMemberId',
    'app_key',
    'app_secret',
    'access_token',
    'seller_member_id'
  ]) delete result[field]
}

function addAlibaba1688CredentialSummary(result, parseAlibaba1688Config) {
  let config = {}
  try {
    config = typeof parseAlibaba1688Config === 'function'
      ? parseAlibaba1688Config(result.config, `accountId=${result.id}`)
      : {}
  } catch {
    config = {}
  }
  result.credentialStatus = ['appKey', 'appSecret', 'accessToken', 'sellerMemberId'].every(field =>
    typeof config[field] === 'string' && Boolean(config[field].trim())
  ) ? 'configured' : 'incomplete'
  result.sellerMemberIdMask = maskSellerMemberId(config.sellerMemberId)
  deleteAlibaba1688Credentials(result)
}

function deleteWechatCredentials(result) {
  for (const field of [
    'config',
    'appId',
    'appSecret',
    'app_id',
    'app_secret'
  ]) delete result[field]
}

function addWechatCredentialSummary(result, parseWechatMiniProgramConfig) {
  let config = {}
  try {
    config = typeof parseWechatMiniProgramConfig === 'function'
      ? parseWechatMiniProgramConfig(result.config, `accountId=${result.id}`)
      : {}
  } catch {
    config = {}
  }
  result.credentialStatus = ['appId', 'appSecret'].every(field =>
    typeof config[field] === 'string' && Boolean(config[field].trim())
  ) ? 'configured' : 'incomplete'
  result.appIdMask = maskIdentifier(config.appId)
  deleteWechatCredentials(result)
}

function addDouyinCredentialSummary(result, parseDouyinConfig) {
  let config = {}
  try {
    config = typeof parseDouyinConfig === 'function'
      ? parseDouyinConfig(result.config, `accountId=${result.id}`)
      : {}
  } catch {
    config = {}
  }
  result.credentialStatus = ['appKey', 'appSecret', 'shopId'].every(field =>
    typeof config[field] === 'string' && Boolean(config[field].trim())
  ) ? 'configured' : 'incomplete'
  result.callbackPath = `/api/channel/douyin/webhook?account_id=${encodeURIComponent(result.id)}`
  delete result.config
  delete result.appKey
  delete result.appSecret
  delete result.shopId
}

function addBridgeCommerceCredentialSummary(result, parser, requiredFields) {
  let config = {}
  try {
    config = typeof parser === 'function' ? parser(result.config, `accountId=${result.id}`) : {}
  } catch {
    config = {}
  }
  result.credentialStatus = requiredFields.every(field =>
    typeof config[field] === 'string' && Boolean(config[field].trim())
  ) ? 'configured' : 'incomplete'
  result.shopIdMask = maskMallId(config.shopId)
  for (const field of [
    'config', 'appKey', 'appId', 'appSecret', 'accessToken', 'shopId',
    'app_key', 'app_id', 'app_secret', 'access_token', 'shop_id'
  ]) delete result[field]
}

function presentChannelAccountListItem(account, {
  parseWahaConfig,
  parseDouyinConfig,
  parsePinduoduoConfig,
  parseTaobaoConfig,
  parseAlibaba1688Config,
  parseWechatMiniProgramConfig,
  parseXiaohongshuConfig,
  parseWechatShopConfig,
  parseKuaishouConfig,
  defaultWahaEngine = 'gows'
} = {}) {
  const result = { ...account }

  if (matchesCommerceAccount(result, 'xiaohongshu', 'xiaohongshu_commerce')) {
    addBridgeCommerceCredentialSummary(result, parseXiaohongshuConfig, ['appKey', 'appSecret', 'accessToken', 'shopId'])
    return result
  }

  if (matchesCommerceAccount(result, 'wechat_shop', 'wechat_shop_commerce')) {
    addBridgeCommerceCredentialSummary(result, parseWechatShopConfig, ['appId', 'appSecret', 'shopId'])
    return result
  }

  if (matchesCommerceAccount(result, 'kuaishou', 'kuaishou_commerce')) {
    addBridgeCommerceCredentialSummary(result, parseKuaishouConfig, ['appKey', 'appSecret', 'accessToken', 'shopId'])
    return result
  }

  if (isDouyinAccount(result)) {
    addDouyinCredentialSummary(result, parseDouyinConfig)
    return result
  }

  if (isPinduoduoAccount(result)) {
    addPinduoduoCredentialSummary(result, parsePinduoduoConfig)
    return result
  }

  if (isTaobaoAccount(result)) {
    addTaobaoCredentialSummary(result, parseTaobaoConfig)
    return result
  }

  if (isAlibaba1688Account(result)) {
    addAlibaba1688CredentialSummary(result, parseAlibaba1688Config)
    return result
  }

  if (isWechatMiniProgramAccount(result)) {
    addWechatCredentialSummary(result, parseWechatMiniProgramConfig)
    return result
  }

  if (isWahaAccount(result)) {
    const config = parseWahaConfig(result.config, `accountId=${result.id}`)
    result.sessionName = config.sessionName || null
    result.port = config.port || null
    result.engine = config.engine || defaultWahaEngine
  }

  delete result.config
  return result
}

function presentChannelAccountDetail(account, {
  parseWahaConfig,
  parseDouyinConfig,
  parsePinduoduoConfig,
  parseTaobaoConfig,
  parseAlibaba1688Config,
  parseWechatMiniProgramConfig,
  parseXiaohongshuConfig,
  parseWechatShopConfig,
  parseKuaishouConfig,
  defaultWahaEngine = 'gows'
} = {}) {
  const result = { ...account }

  if (matchesCommerceAccount(result, 'xiaohongshu', 'xiaohongshu_commerce')) {
    addBridgeCommerceCredentialSummary(result, parseXiaohongshuConfig, ['appKey', 'appSecret', 'accessToken', 'shopId'])
    return result
  }

  if (matchesCommerceAccount(result, 'wechat_shop', 'wechat_shop_commerce')) {
    addBridgeCommerceCredentialSummary(result, parseWechatShopConfig, ['appId', 'appSecret', 'shopId'])
    return result
  }

  if (matchesCommerceAccount(result, 'kuaishou', 'kuaishou_commerce')) {
    addBridgeCommerceCredentialSummary(result, parseKuaishouConfig, ['appKey', 'appSecret', 'accessToken', 'shopId'])
    return result
  }

  if (isDouyinAccount(result)) {
    addDouyinCredentialSummary(result, parseDouyinConfig)
    return result
  }

  if (isPinduoduoAccount(result)) {
    addPinduoduoCredentialSummary(result, parsePinduoduoConfig)
    return result
  }

  if (isTaobaoAccount(result)) {
    addTaobaoCredentialSummary(result, parseTaobaoConfig)
    return result
  }

  if (isAlibaba1688Account(result)) {
    addAlibaba1688CredentialSummary(result, parseAlibaba1688Config)
    return result
  }

  if (isWechatMiniProgramAccount(result)) {
    addWechatCredentialSummary(result, parseWechatMiniProgramConfig)
    return result
  }

  if (!isWahaAccount(result)) {
    delete result.config
    return result
  }

  const config = parseWahaConfig(result.config, `accountId=${result.id}`)
  result.config = {
    sessionName: config.sessionName,
    wahaInstanceUrl: config.wahaInstanceUrl,
    port: config.port,
    engine: config.engine || defaultWahaEngine,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}******` : null
  }
  return result
}

module.exports = {
  presentChannelAccountListItem,
  presentChannelAccountDetail
}
