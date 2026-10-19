/**
 * 把千帆桌面采集的订单入库（orders 表，按订单号幂等）。
 *
 * 正常通路是节点通过 WS 上报 `commerce.orders.scraped`（见
 * src/modules/desktop-bridge/scrapedOrderIngestService.js），本脚本用于
 * **人工补录 / 验证**：读取采集器落盘的 JSON，走同一个入库服务，不另写一套映射。
 *
 * 用法：
 *   node scripts/ingest-scraped-orders.js [采集结果 JSON 路径]
 * 默认读取：Rag/tools/qianfan-uia-probe/out/qianfan_orders_latest.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const fs = require('fs')
const path = require('path')
const { sequelize } = require('../src/config/database')
const { createScrapedOrderIngestService } = require('../src/modules/desktop-bridge/scrapedOrderIngestService')

const DEFAULT_INPUT = path.join(
  __dirname, '..', '..', 'tools', 'qianfan-uia-probe', 'out', 'qianfan_orders_latest.json'
)

async function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT
  const accountId = Number(process.argv[3])
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error('Usage: node scripts/ingest-scraped-orders.js <json-path> <account-id>')
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`采集结果不存在：${inputPath}`)
    process.exit(1)
  }
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const orders = ((payload.orders || {}).rows) || []
  if (!orders.length) {
    console.log('采集结果里没有订单行，无事可做')
    process.exit(0)
  }

  const service = createScrapedOrderIngestService({ sequelize })
  const result = await service.handle({
    trustedLocal: true,
    envelope: {
      type: 'commerce.orders.scraped',
      payload: {
        accountId,
        adapterId: payload.adapterId || 'xiaohongshu.qianfan',
        source: 'qianfan_orders_manual',
        capturedAt: payload.capturedAt,
        orders
      }
    }
  })

  console.log(`[订单入库] ${result.status}：${result.message || ''}`)
  console.log(`  来源：${inputPath}`)
  console.log(`  采集时间：${payload.capturedAt || '未知'}`)
  await sequelize.close()
  process.exit(result.status === 'processed' ? 0 : 1)
}

main().catch(error => {
  console.error('[订单入库] 失败:', error.message)
  process.exit(1)
})
