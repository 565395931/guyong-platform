/**
 * 渠道 Webhook 路由
 *
 * 动态路由：POST /api/channel/:channel/webhook
 * 根据 :channel 参数从适配器注册中心获取对应适配器
 *
 * 目前支持：
 * - whatsapp → WAHA 适配器
 */

const express = require('express')
const router = express.Router()
const { getAdapterByChannel } = require('../modules/channel-adapters')
const messagingService = require('../modules/messaging/messaging.service')
const { processInboundMessageAfterStore } = require('../modules/messaging/inboundMessage.service')
const systemLogger = require('../utils/systemLogger')
const { ChannelAccount } = require('../models')
const { sequelize } = require('../config/database')
const { decrypt } = require('../shared/utils/encrypt')
const { createChannelEventInboxRepository } = require('../modules/channel-events/channelEventInbox.repository')
const { createDouyinWebhookHandler } = require('../modules/channel-adapters/douyin-commerce/douyinWebhook')

const douyinWebhookHandler = createDouyinWebhookHandler({
  loadAccount: async accountId => {
    const account = await ChannelAccount.findByPk(accountId)
    if (!account) return null
    const plain = account.toJSON()
    return { ...plain, config: decrypt(plain.config) }
  },
  getAdapter: () => getAdapterByChannel('douyin'),
  eventInbox: createChannelEventInboxRepository(sequelize),
  schedule: task => setImmediate(() => task().catch(error => {
    systemLogger.error('douyin.event_schedule_failed', { error })
  })),
  logger: systemLogger
})

function getEventCount(body) {
  if (Array.isArray(body)) return body.length
  return body ? 1 : 0
}

function getEventNames(body) {
  const events = Array.isArray(body) ? body : [body]
  return events
    .filter(Boolean)
    .map(evt => evt.event || evt.type || evt.eventName || evt._event || 'unknown')
    .slice(0, 10)
}

/**
 * POST /api/channel/:channel/webhook
 * 接收渠道推送的消息事件
 *
 * query 参数：
 *   account_id - 可选，指定账号 ID
 */
router.post('/:channel/webhook', async (req, res) => {
  const { channel } = req.params
  let accountId = req.query.account_id || req.body?._accountId || null
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  systemLogger.info('webhook.received', {
    requestId,
    channel,
    accountId,
    eventCount: getEventCount(req.body),
    eventNames: getEventNames(req.body),
    remoteAddress: req.ip,
    userAgent: req.get('user-agent')
  })

  if (channel === 'douyin') return douyinWebhookHandler(req, res)

  try {
    // 1. 获取适配器
    const adapter = getAdapterByChannel(channel)
    if (!adapter) {
      systemLogger.warn('webhook.unsupported_channel', { requestId, channel })
      return res.status(404).json({ success: false, message: `不支持的渠道: ${channel}` })
    }

    // 1.5 accountId 缺失时不再猜测（旧的 ORDER BY id LIMIT 1 会导致多账号串号）
    // 正确的 webhook URL 应由 session 启动时通过 buildWebhookConfig() 传入 ?account_id=N
    if (!accountId && channel === 'whatsapp') {
      systemLogger.warn('webhook.missing_account_id', { requestId, channel })
      console.warn('[Webhook] WhatsApp webhook 缺少 account_id 参数，拒绝处理（防止串号）。请检查 session 启动时是否正确配置了 webhook URL')
      return res.status(200).json({
        success: false,
        message: 'webhook 缺少 account_id 参数，已拒绝处理（防止多账号串号）'
      })
    }

    // 2. 注入 accountId 到 payload（WAHA 适配器需要）
    if (accountId) {
      if (Array.isArray(req.body)) {
        req.body.forEach(evt => { evt._accountId = accountId })
      } else if (typeof req.body === 'object') {
        req.body._accountId = accountId
      }
    }

    // 3. 调用适配器解析事件
    const messages = await adapter.receiveEvent(req.body)
    systemLogger.info('webhook.parsed', {
      requestId,
      channel,
      accountId,
      messageCount: messages?.length || 0
    })

    if (!messages || messages.length === 0) {
      systemLogger.info('webhook.no_messages', { requestId, channel, accountId })
      return res.json({ success: true, message: '无消息需处理' })
    }

    // 4. 遍历消息，交给 messaging 模块处理
    const eventEmitter = req.app.get('eventEmitter')
    let processed = 0
    let duplicates = 0
    for (const msg of messages) {
      try {
        // TODO: 媒体文件下载转存
        const storedMessage = await messagingService.processIncomingMessage(msg, eventEmitter)
        if (storedMessage?.duplicate) {
          duplicates++
          systemLogger.info('webhook.duplicate_skipped', {
            requestId,
            channel,
            accountId: msg.accountId || accountId,
            conversationId: storedMessage.conversationId || msg.conversationId,
            channelMessageId: msg.channelMessageId || null,
            existingMessageId: storedMessage.id || null
          })
          continue
        }
        processed++
        systemLogger.info('webhook.message_processed', {
          requestId,
          channel,
          accountId: msg.accountId || accountId,
          conversationId: msg.conversationId,
          channelMessageId: msg.channelMessageId || msg.id || null,
          channelUserId: systemLogger.maskValue(msg.channelUserId || msg.userId),
          messageType: msg.messageType || 'text',
          direction: msg.direction || 'inbound'
        })

        // 5. 统一执行入池复查和 AI 回复任务入队
        try {
          await processInboundMessageAfterStore(msg, eventEmitter, {
            source: 'channel_webhook',
            eventId: msg.channelMessageId || msg.id || null
          })
        } catch (routeErr) {
          systemLogger.error('webhook.route_failed', {
            requestId,
            conversationId: msg.conversationId,
            error: routeErr
          })
          console.error('[Webhook] 消息入池路由失败:', routeErr.message)
        }
      } catch (msgErr) {
        systemLogger.error('webhook.message_failed', {
          requestId,
          channel,
          accountId: msg.accountId || accountId,
          channelMessageId: msg.channelMessageId || msg.id || null,
          error: msgErr
        })
        console.error('[Webhook] 处理单条消息失败:', msgErr.message)
      }
    }

    systemLogger.info('webhook.completed', {
      requestId,
      channel,
      accountId,
      total: messages.length,
      processed,
      duplicates
    })

    res.json({
      success: true,
      message: `已处理 ${processed} 条消息${duplicates ? `，跳过重复 ${duplicates} 条` : ''}`,
      data: { total: messages.length, processed, duplicates }
    })
  } catch (err) {
    systemLogger.error('webhook.failed', {
      requestId,
      channel,
      accountId,
      error: err
    })
    console.error(`[Webhook] ${channel} 处理失败:`, err.message)
    // 返回 200 避免 Webhook 重试风暴
    res.status(200).json({ success: false, message: err.message })
  }
})

/**
 * GET /api/channel/:channel/webhook
 * 用于渠道平台验证 Webhook 地址
 */
router.get('/:channel/webhook', (req, res) => {
  const { channel } = req.params
  // WAHA 不需要特殊验证，直接返回成功
  res.json({ success: true, message: `${channel} Webhook 已就绪` })
})

module.exports = router
