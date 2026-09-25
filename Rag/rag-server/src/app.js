const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const http = require('http')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('events')
const systemLogger = require('./utils/systemLogger')
const { captureRawBody } = require('./middleware/captureRawBody')

// 加载环境变量
dotenv.config()
systemLogger.info('server.process_start', {
  pid: process.pid,
  nodeVersion: process.version,
  nodeEnv: process.env.NODE_ENV || 'development',
  cwd: process.cwd()
})

process.on('uncaughtException', (err) => {
  systemLogger.error('server.uncaught_exception', { error: err })
  console.error('[System] Uncaught exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  systemLogger.error('server.unhandled_rejection', { reason })
  console.error('[System] Unhandled rejection:', reason)
})

process.on('exit', (code) => {
  systemLogger.info('server.process_exit', { code })
})

// 全局事件发射器（用于业务模块 → WebSocket 推送的进程内通信）
const eventEmitter = new EventEmitter()
eventEmitter.setMaxListeners(20) // 避免监听器过多警告

// 导入路由
const { ragRoutes } = require('./modules/rag')
const authRoutes = require('./routes/auth')
const channelWebhookRoutes = require('./routes/channelWebhook')
const channelAccountRoutes = require('./routes/channelAccounts')
const campaignRoutes = require('./routes/campaigns')
const seatBindingRoutes = require('./routes/seatAccountBindings')
const conversationRoutes = require('./routes/conversations')
const wahaProxyRoutes = require('./routes/wahaProxy')
const testToolRoutes = require('./routes/testTool')
const mediaFileRoutes = require('./routes/mediaFiles')
const videoRoutes = require('./routes/video')
const videoDataRoutes = require('./routes/videoData')
const quickReplyRoutes = require('./routes/quickReplies')
const statisticsRoutes = require('./routes/statistics')
const orderRoutes = require('./routes/orders')
const customerRoutes = require('./routes/customers')
const channelStatusRoutes = require('./routes/channelStatus')
const toolsInvoiceRoutes = require('./routes/toolsInvoices')
const systemLogRoutes = require('./routes/systemLogs')
const { createSystemControlRouter } = require('./routes/systemControl')
const catalogRoutes = require('./modules/catalog')
const warehouseRoutes = require('./modules/warehouse')
const platformSkuMappingRoutes = require('./modules/platform-sku-mapping')
const orderFulfillmentRoutes = require('./modules/order-fulfillment')
const platformConnectionsRoutes = require('./modules/platform-connections')
const messageReviewModule = require('./modules/message-review')
const { systemAccountsRoutes } = require('./modules/system-accounts')
const { sequelize } = require('./config/database')
const { createChannelEventInboxRepository } = require('./modules/channel-events/channelEventInbox.repository')
const { createChannelEventsRouter } = require('./modules/channel-events/channelEvents.routes')
const { createCampaignRepository } = require('./modules/campaigns/campaign.repository')
const { createCampaignDispatcher } = require('./modules/campaigns/campaignDispatcher')
const { createCommerceProjectionRuntime } = require('./modules/commerce-projection/commerceProjectionRuntime')
const { createCommerceProjectionAdminRepository } = require('./modules/commerce-projection/commerceProjectionAdminRepository')
const { createCommerceProjectionAdminRouter } = require('./modules/commerce-projection/commerceProjectionAdminRoutes')

// 导入数据库连接
const { connectDB } = require('./config/database')

// 导入 WebSocket 模块
const { initializeWebSocket } = require('./modules/websocket')

// 导入渠道适配器注册中心
const { initAdapters, getAdapterByChannel } = require('./modules/channel-adapters')

// 导入会话池定时器服务
const { startPoolTimers } = require('./modules/conversation-pool/pool-timer.service')
const { createCustomerOperationsRepository } = require('./modules/customer-operations/customerOperations.repository')
const { createCustomerAiService, createDefaultCustomerAiProvider } = require('./modules/customer-operations/customerAi.service')
const { createCustomerOperationsWorker } = require('./modules/customer-operations/customerOperations.worker')
const { createCustomerOperationsTimer } = require('./modules/customer-operations/customerOperations.timer')

// 导入配置服务和 AI 回复 Worker
const configService = require('./services/configService')
const { initAiReplyWorker } = require('./workers/aiReplyWorker')
const { initPinduoduoSyncWorker } = require('./workers/pinduoduoSyncWorker')
const { initTaobaoSyncWorker } = require('./workers/taobaoSyncWorker')
const { initAlibaba1688SyncWorker } = require('./workers/alibaba1688SyncWorker')
const { initCloudGateway } = require('./modules/cloud-gateway')
const { resolveCloudGatewayCredential } = require('./modules/cloud-gateway/credentialResolver')
const { shouldEnableCloudGateway } = require('./modules/cloud-gateway/startup')
const { findCloudGatewayAccountMapping } = require('./modules/cloud-gateway/accountMapping')

const customerOperationsRepository = createCustomerOperationsRepository()
const customerAiService = createCustomerAiService({ provider: createDefaultCustomerAiProvider })
const customerOperationsWorker = createCustomerOperationsWorker({
  repository: customerOperationsRepository,
  aiService: customerAiService,
  logger: systemLogger
})
const customerOperationsTimer = createCustomerOperationsTimer({
  runPendingWork: () => customerOperationsWorker.runPendingWork(),
  logger: systemLogger
})
const campaignRepository = createCampaignRepository(sequelize)
const campaignDispatcher = createCampaignDispatcher({
  repository: campaignRepository,
  adapterResolver: getAdapterByChannel,
  logger: systemLogger
})
const commerceProjectionRuntime = createCommerceProjectionRuntime({
  sequelize,
  environment: process.env,
  logger: systemLogger
})
const commerceProjectionAdminRepository = createCommerceProjectionAdminRepository(sequelize)

const app = express()

// 连接数据库
connectDB().then(async () => {
  systemLogger.info('server.database_connected')
  if (process.env.NODE_ENV !== 'test') {
    try {
      initPinduoduoSyncWorker({ sequelize })
      systemLogger.info('server.pinduoduo_sync_worker_started')
    } catch (error) {
      systemLogger.error('server.pinduoduo_sync_worker_failed', {
        code: error?.code || 'PINDUODUO_WORKER_INIT_FAILED'
      })
    }
    try {
      initTaobaoSyncWorker({ sequelize })
      systemLogger.info('server.taobao_sync_worker_started')
    } catch (error) {
      systemLogger.error('server.taobao_sync_worker_failed', {
        code: error?.code || 'TAOBAO_WORKER_INIT_FAILED'
      })
    }
    try {
      initAlibaba1688SyncWorker({ sequelize })
      systemLogger.info('server.alibaba1688_sync_worker_started')
    } catch (error) {
      systemLogger.error('server.alibaba1688_sync_worker_failed', {
        code: error?.code || 'ALIBABA1688_WORKER_INIT_FAILED'
      })
    }
    if (commerceProjectionRuntime.enabled) {
      commerceProjectionRuntime.start()
      systemLogger.info('server.commerce_projection_worker_started')
    }
  }
  // 数据库连接成功后，初始化配置服务（预加载配置到 Redis + 订阅刷新通知）
  try {
    await configService.preloadConfigs()
    await configService.initConfigService()
    await require('./modules/ai-provider/providerService').getProviderService().applyRuntimeCredential()
    systemLogger.info('server.config_service_ready')
  } catch (err) {
    systemLogger.error('server.config_service_failed', { error: err })
    console.error('配置服务初始化失败（Redis 可能未启动）:', err.message)
    console.error('请启动 Redis: cd docker/redis && docker compose up -d')
  }
})

// 初始化渠道适配器
initAdapters()

// 中间件
app.use(cors())
app.use(express.json({ verify: captureRawBody }))
app.use(express.urlencoded({ extended: true }))

// ========== 静态文件：用户头像 ==========
const AVATAR_DIR = path.join(__dirname, 'public', 'avatars')
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true })
  console.log('头像目录已创建:', AVATAR_DIR)
}
app.use('/api/avatars', express.static(AVATAR_DIR, {
  maxAge: '7d',
  etag: true
}))

// ========== 静态文件：可发送媒体文件 ==========
const MEDIA_FILE_DIR = path.join(__dirname, 'public', 'media-files')
if (!fs.existsSync(MEDIA_FILE_DIR)) {
  fs.mkdirSync(MEDIA_FILE_DIR, { recursive: true })
  console.log('媒体文件目录已创建:', MEDIA_FILE_DIR)
}
app.use('/api/media-files/static', express.static(MEDIA_FILE_DIR, {
  maxAge: '30d',
  etag: true
}))

// ========== 静态文件：平台生成的 PI 发票 ==========
const INVOICE_FILE_DIR = path.join(__dirname, 'public', 'generated-invoices')
if (!fs.existsSync(INVOICE_FILE_DIR)) {
  fs.mkdirSync(INVOICE_FILE_DIR, { recursive: true })
  console.log('发票文件目录已创建', INVOICE_FILE_DIR)
}
app.use('/api/invoices/static', express.static(INVOICE_FILE_DIR, {
  maxAge: '0',
  etag: true
}))

// ========== 静态文件：订单附件 ==========
const ORDER_ATTACHMENT_DIR = path.join(__dirname, 'public', 'order-attachments')
if (!fs.existsSync(ORDER_ATTACHMENT_DIR)) {
  fs.mkdirSync(ORDER_ATTACHMENT_DIR, { recursive: true })
  console.log('订单附件目录已创建', ORDER_ATTACHMENT_DIR)
}
app.use('/api/order-attachments/static', express.static(ORDER_ATTACHMENT_DIR, {
  maxAge: '30d',
  etag: true
}))

// ========== 全局错误处理包装器 ==========
// 用于包装异步路由，自动捕获错误
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next)
}

// 将 asyncHandler 挂载到 app 上，供路由使用
app.set('asyncHandler', asyncHandler)

// 将 eventEmitter 挂载到 app 上，供路由/模块使用
app.set('eventEmitter', eventEmitter)
messageReviewModule.setEventEmitter(eventEmitter)

// RAG 模块路由（统一注册 chat/knowledge/langchain/upload/local/template/admin）
app.use('/api', ragRoutes)
// 认证路由（独立模块）
app.use('/api/auth', authRoutes)

// 渠道 Webhook 路由（无需认证，由各渠道自行验证签名）
app.use('/api/channel', channelWebhookRoutes)
// 渠道账号管理路由（需 JWT 认证 + admin/supervisor 权限）
app.use('/api/v1/channel-accounts', channelAccountRoutes)
app.use('/api/v1/campaigns', campaignRoutes)
app.use('/api/v1/video', videoRoutes)
app.use('/api/v1/video-data', videoDataRoutes)
app.use('/api/v1/channel-events', createChannelEventsRouter({
  repository: createChannelEventInboxRepository(sequelize)
}))
app.use('/api/v1/commerce-projections', createCommerceProjectionAdminRouter({
  repository: commerceProjectionAdminRepository
}))
// 坐席账号绑定管理路由（需 JWT 认证 + admin/supervisor 权限）
app.use('/api/v1/seat-bindings', seatBindingRoutes)
// 聚合平台会话与消息路由（需 JWT 认证 + agent/supervisor/admin 权限）
app.use('/api/v1/conversations', conversationRoutes)
// WAHA Session 代理路由（需 JWT 认证 + admin 权限）
app.use('/api/v1/waha', wahaProxyRoutes)
// 测试工具路由（需 JWT 认证 + admin 权限）
app.use('/api/v1/test-tool', testToolRoutes)
// 系统日志查询路由（admin）
app.use('/api/v1/system-logs', systemLogRoutes)
// 本地测试运维控制（需 JWT 认证 + admin 权限；生产环境默认关闭）
app.use('/api/v1/system-control', createSystemControlRouter())
// 媒体文件管理路由（上传需 admin/supervisor/agent，删除需 admin/supervisor）
app.use('/api/v1/media-files', mediaFileRoutes)
// 快捷指令管理路由（查询需 agent/supervisor/admin，管理需 admin/supervisor）
app.use('/api/v1/quick-replies', quickReplyRoutes)
// 数据统计路由（agent 看自己，supervisor/admin 看全员）
app.use('/api/v1/statistics', statisticsRoutes)
// 成交订单管理路由
app.use('/api/v1/orders', orderRoutes)
// 多渠道连接状态路由（agent/supervisor/admin 均可访问）
app.use('/api/v1/channels/status', channelStatusRoutes)
// 客户管理路由
app.use('/api/v1/customers', customerRoutes)
// 产品、SKU、价格、运费、导入与精确报价
app.use('/api/v1/catalog', catalogRoutes)
app.use('/api/v1/warehouses', warehouseRoutes)
app.use('/api/v1/platform-sku-mappings', platformSkuMappingRoutes)
app.use('/api/v1/fulfillment', orderFulfillmentRoutes)
app.use('/api/v1/platform-connections', platformConnectionsRoutes)
app.use('/api/v1/message-reviews', messageReviewModule.reviewRoutes)
app.use('/api/v1/system-accounts', systemAccountsRoutes)
// 功能模块：PI 发票生成工具
app.use('/api/v1/tools/invoices', toolsInvoiceRoutes)

// ========== 全局错误处理中间件 ==========
app.use((err, req, res, next) => {
  // 打印详细错误信息到控制台
  console.error('========== 错误详情 ==========')
  console.error('错误时间:', new Date().toISOString())
  console.error('请求路径:', req.method, req.originalUrl)
  console.error('错误类型:', err.name)
  console.error('错误消息:', err.message)
  console.error('错误堆栈:', err.stack)
  console.error('==============================')
  
  // 根据错误类型返回不同的状态码和消息
  let statusCode = err.status || err.statusCode || 500
  let errorMessage = err.message || '服务器内部错误'
  
  // 处理特定错误类型
  if (err.name === 'ValidationError') {
    statusCode = 400
    errorMessage = `参数校验失败: ${err.message}`
  } else if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    statusCode = 401
    errorMessage = '认证失败，请重新登录'
  } else if (err.name === 'NotFoundError') {
    statusCode = 404
    errorMessage = err.message || '资源不存在'
  } else if (err.code === 'ECONNREFUSED') {
    statusCode = 503
    errorMessage = '数据库连接失败，请检查数据库服务'
  } else if (err.message && err.message.includes('doesn\'t exist')) {
    statusCode = 500
    errorMessage = `数据库表不存在: ${err.message}`
  } else if (statusCode === 500) {
    // 生产环境隐藏详细错误，开发环境显示
    const isDev = process.env.NODE_ENV !== 'production'
    errorMessage = isDev ? err.message : '服务器内部错误'
  }
  
  // 返回统一格式的错误响应
  systemLogger.error('http.request_error', {
    method: req.method,
    url: req.originalUrl,
    statusCode,
    errorName: err.name,
    errorMessage: err.message,
    stack: err.stack,
    query: req.query,
    params: req.params
  })

  res.status(statusCode).json({
    success: false,
    message: errorMessage,
    error: process.env.NODE_ENV !== 'production' ? {
      type: err.name,
      stack: err.stack?.split('\n').slice(0, 5).join('\n')
    } : undefined,
    timestamp: new Date().toISOString(),
    path: req.originalUrl
  })
})

// ========== 404 处理 ==========
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `接口不存在: ${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString()
  })
})

// ========== 创建 HTTP 服务器并集成 WebSocket ==========
const httpServer = http.createServer(app)
initializeWebSocket(httpServer, eventEmitter)

// 云网关连接器默认关闭；显式启用时仅新增通用 WSS 传输，不改变 WAHA/GOWS 行为。
const cloudGatewayCredential = resolveCloudGatewayCredential(process.env)
const cloudGatewayEnabled = shouldEnableCloudGateway({
  env: process.env,
  credential: cloudGatewayCredential
})
let cloudGatewayAccounts = []
try {
  cloudGatewayAccounts = JSON.parse(process.env.CLOUD_GATEWAY_ACCOUNTS_JSON || '[]')
} catch (error) {
  console.error('[CloudGateway] CLOUD_GATEWAY_ACCOUNTS_JSON 解析失败:', error.message)
}
const cloudGateway = initCloudGateway({
  eventEmitter,
  accountEntries: cloudGatewayAccounts,
  options: {
    enabled: cloudGatewayEnabled,
    url: process.env.CLOUD_GATEWAY_URL,
    authTokenProvider: () => cloudGatewayCredential.token,
    accountLoader: findCloudGatewayAccountMapping,
    clientId: process.env.CLOUD_GATEWAY_CLIENT_ID || 'rag-server'
  }
})
app.set('cloudGateway', cloudGateway)

// 启动服务器
const PORT = Number.parseInt(process.env.PORT || '3001', 10)
const HOST = process.env.BIND_HOST || process.env.HOST || '0.0.0.0'
httpServer.listen(PORT, HOST, () => {
  const lanHint = HOST === '0.0.0.0' || HOST === '::'
    ? `http://<本机局域网IP>:${PORT}`
    : `http://${HOST}:${PORT}`

  systemLogger.info('server.listen', { host: HOST, port: PORT, websocket: true })
  console.log(`服务器监听地址 ${HOST}:${PORT}`)
  console.log(`局域网访问示例 ${lanHint}`)
  console.log(`WebSocket 服务已就绪 (${lanHint.replace(/^http/, 'ws')})`)

  // 启动会话池定时器（AI自助池超时退出、待人工池超龄转公共池、公共池超龄归档）
  startPoolTimers(eventEmitter)
  systemLogger.info('server.pool_timers_started')
  if (process.env.NODE_ENV !== 'test') {
    customerOperationsTimer.start()
    systemLogger.info('server.customer_operations_timer_started')
    try {
      campaignDispatcher.start({
        intervalMs: Number(process.env.CAMPAIGN_DISPATCH_INTERVAL_MS || 2000)
      })
      systemLogger.info('server.campaign_dispatcher_started')
    } catch (err) {
      systemLogger.error('server.campaign_dispatcher_failed', { error: err })
      console.error('Campaign dispatcher start failed:', err.message)
    }
  }
  console.log('会话池定时器已启动')

  // 启动 AI 回复 Worker（从 BullMQ 队列消费任务）
  try {
    initAiReplyWorker(eventEmitter)
    systemLogger.info('server.ai_reply_worker_started')
    console.log('AI 回复 Worker 已启动')
  } catch (err) {
    systemLogger.error('server.ai_reply_worker_failed', { error: err })
    console.error('AI 回复 Worker 启动失败（Redis 可能未启动）:', err.message)
  }
})

// 导出 app 和 eventEmitter 供其他模块使用
module.exports = { app, asyncHandler, eventEmitter, cloudGateway, commerceProjectionRuntime }
