#!/usr/bin/env node
/**
 * 用项目自带的 bridgeProtocol 校验抓取端产出的 message.inbound 负载。
 *
 * 这是集成接缝的最小单元测试：校验通过说明抓取端的数据形状能被现有桥接协议接受，
 * 不需要改动或启动后端。
 *
 * 用法:
 *   node validate_envelope.js <bridgeProtocol.js 路径> <payloads.json> <nodeId(uuid)>
 */

'use strict'

const fs = require('fs')
const path = require('path')

const [, , protocolPath, payloadFile, nodeId] = process.argv

if (!protocolPath || !payloadFile || !nodeId) {
  console.error('用法: node validate_envelope.js <bridgeProtocol.js> <payloads.json> <nodeId>')
  process.exit(2)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!UUID_RE.test(nodeId)) {
  console.error(`nodeId 必须是 uuid，收到: ${nodeId}`)
  process.exit(2)
}

const proto = require(path.resolve(protocolPath))
const payloads = JSON.parse(fs.readFileSync(payloadFile, 'utf8'))

const report = {
  protocolVersion: proto.PROTOCOL_VERSION,
  supportedTypes: proto.TYPES,
  total: payloads.length,
  ok: 0,
  failed: 0,
  failures: [],
  samples: []
}

for (let i = 0; i < payloads.length; i++) {
  const payload = payloads[i]
  try {
    // 1) 用项目自带工厂构造事件（内部会跑一遍 zod）
    const event = proto.createEvent({
      type: 'message.inbound',
      nodeId,
      payload
    })

    // 2) 再走一次完整的序列化 + 解析，验证线上真实路径
    const parsed = proto.parseEnvelope(JSON.stringify(event))

    // 3) 关键字段自检
    if (parsed.type !== 'message.inbound') throw new Error('type 不匹配')
    if (parsed.payload.channelMessageId !== payload.channelMessageId) {
      throw new Error('channelMessageId 往返不一致')
    }
    if (parsed.nodeId !== nodeId) throw new Error('nodeId 往返不一致')

    report.ok++
    if (report.samples.length < 3) {
      report.samples.push({
        index: i,
        messageType: parsed.payload.messageType,
        direction: parsed.payload.platformPayload?.direction,
        hasContent: Boolean(parsed.payload.content),
        mediaCount: (parsed.payload.media || []).length,
        timePrecision: parsed.payload.platformPayload?.timePrecision,
        clientTimestamp: parsed.payload.clientTimestamp || null,
        eventIdValid: UUID_RE.test(parsed.eventId)
      })
    }
  } catch (error) {
    report.failed++
    const detail = error && error.cause && error.cause.issues
      ? error.cause.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : (error && error.message) || String(error)
    report.failures.push({ index: i, error: detail })
  }
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.failed > 0 ? 1 : 0)
