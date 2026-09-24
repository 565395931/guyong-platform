const { spawnSync } = require('child_process')
const { randomUUID } = require('crypto')
const path = require('path')
const { sequelize } = require('../src/config/database')

const DEFAULT_DB_PATH = 'C:\\Users\\Administrator\\Desktop\\功能模块\\成单管理\\customers.db'
const PYTHON_EXE = process.env.PYTHON_EXE || 'python'

function readSqliteRows(dbPath) {
  const code = `
import json, sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')
db_path = sys.argv[1]
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
rows = [dict(row) for row in con.execute("SELECT * FROM customers ORDER BY id ASC")]
con.close()
print(json.dumps(rows, ensure_ascii=False))
`
  const result = spawnSync(PYTHON_EXE, ['-c', code, dbPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to read sqlite database')
  }
  return JSON.parse(result.stdout || '[]')
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

function numberOrNull(value) {
  const normalized = emptyToNull(value)
  if (normalized === null) return null
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function dateOrNull(value) {
  const normalized = emptyToNull(value)
  if (!normalized) return null
  const text = String(normalized).trim().replace(/\//g, '-').replace(/\./g, '-')
  if (/^\d{2}-\d{1,2}-\d{1,2}$/.test(text)) return `20${text}`
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return text
  return null
}

function inferStatus(row) {
  if (dateOrNull(row.arrival_time)) return 'delivered'
  if (emptyToNull(row.international_tracking)) return 'international_shipping'
  if (emptyToNull(row.domestic_tracking)) return 'domestic_shipping'
  if (numberOrNull(row.deal_amount) !== null) return 'confirmed'
  return 'draft'
}

function buildOrder(row) {
  const dealAmount = numberOrNull(row.deal_amount)
  const costAmount = numberOrNull(row.shipping_fee)
  const marketingAmount = numberOrNull(row.marketing_amount)
    ?? (dealAmount !== null && costAmount !== null ? Number((dealAmount - costAmount).toFixed(2)) : null)
  return {
    id: randomUUID(),
    orderNo: `LEGACY-${row.id}`,
    channelUserId: emptyToNull(row.account),
    customerName: emptyToNull(row.name),
    customerAddress: emptyToNull(row.address),
    status: inferStatus(row),
    paymentStatus: dealAmount !== null ? 'paid' : 'unpaid',
    paymentPlatform: emptyToNull(row.payment_platform),
    currency: 'USD',
    goodsAmount: dealAmount,
    shippingAmount: row.free_shipping ? 0 : null,
    dealAmount,
    costAmount,
    freightFeeRmb: numberOrNull(row.freight_fee),
    marketingAmount,
    purchaseTime: dateOrNull(row.purchase_time),
    notes: emptyToNull(row.notes),
    rawPayload: JSON.stringify({
      legacy_source: 'desktop_order_manager',
      legacy_id: row.id,
      legacy_account: row.account,
      legacy_row: row
    })
  }
}

function buildItems(row, orderId) {
  const description = emptyToNull(row.purchase_amount) || 'Imported item'
  const unitPrice = numberOrNull(row.deal_amount)
  return [{
    id: randomUUID(),
    orderId,
    productName: description,
    specification: null,
    description,
    quantity: 1,
    unitPrice,
    currency: 'USD',
    totalAmount: unitPrice,
    sortOrder: 0
  }]
}

function buildShipments(row, orderId) {
  const shipments = []
  const courier = emptyToNull(row.courier)
  const domesticTracking = emptyToNull(row.domestic_tracking)
  const internationalTracking = emptyToNull(row.international_tracking)
  if (domesticTracking) {
    shipments.push({
      id: randomUUID(),
      orderId,
      shipmentType: 'domestic',
      courier,
      trackingNo: domesticTracking,
      status: 'shipped',
      expectedArrivalAt: null,
      arrivedAt: null,
      addressDetail: null,
      freightFee: null
    })
  }
  if (internationalTracking || row.expected_arrival || row.arrival_time || row.detailed_address) {
    shipments.push({
      id: randomUUID(),
      orderId,
      shipmentType: 'international',
      courier,
      trackingNo: internationalTracking,
      status: dateOrNull(row.arrival_time) ? 'delivered' : (internationalTracking ? 'shipped' : 'pending'),
      expectedArrivalAt: dateOrNull(row.expected_arrival),
      arrivedAt: dateOrNull(row.arrival_time),
      addressDetail: emptyToNull(row.detailed_address),
      freightFee: numberOrNull(row.freight_fee)
    })
  }
  return shipments
}

async function importRow(row) {
  const order = buildOrder(row)
  const [existing] = await sequelize.query(
    'SELECT id FROM orders WHERE order_no = :orderNo LIMIT 1',
    { replacements: { orderNo: order.orderNo } }
  )
  if (existing.length > 0) return { status: 'skipped', orderNo: order.orderNo }

  const transaction = await sequelize.transaction()
  try {
    await sequelize.query(
      `INSERT INTO orders
        (id, order_no, channel, channel_user_id, customer_name, customer_address, status, payment_status,
         payment_platform, currency, goods_amount, shipping_amount, deal_amount, cost_amount, freight_fee_rmb,
         marketing_amount, purchase_time, notes, raw_payload, created_at, updated_at)
       VALUES
        (:id, :orderNo, 'legacy', :channelUserId, :customerName, :customerAddress, :status, :paymentStatus,
         :paymentPlatform, :currency, :goodsAmount, :shippingAmount, :dealAmount, :costAmount, :freightFeeRmb,
         :marketingAmount, :purchaseTime, :notes, :rawPayload, NOW(), NOW())`,
      { replacements: order, transaction }
    )

    for (const item of buildItems(row, order.id)) {
      await sequelize.query(
        `INSERT INTO order_items
          (id, order_id, product_name, specification, description, quantity, unit_price, currency, total_amount, sort_order, created_at, updated_at)
         VALUES
          (:id, :orderId, :productName, :specification, :description, :quantity, :unitPrice, :currency, :totalAmount, :sortOrder, NOW(), NOW())`,
        { replacements: item, transaction }
      )
    }

    for (const shipment of buildShipments(row, order.id)) {
      await sequelize.query(
        `INSERT INTO order_shipments
          (id, order_id, shipment_type, courier, tracking_no, status, expected_arrival_at, arrived_at, address_detail, freight_fee, created_at, updated_at)
         VALUES
          (:id, :orderId, :shipmentType, :courier, :trackingNo, :status, :expectedArrivalAt, :arrivedAt, :addressDetail, :freightFee, NOW(), NOW())`,
        { replacements: shipment, transaction }
      )
    }

    await sequelize.query(
      `INSERT INTO order_events
        (id, order_id, event_type, title, description, payload, created_at)
       VALUES
        (:id, :orderId, 'legacy_imported', '导入旧成单记录', :description, :payload, NOW())`,
      {
        replacements: {
          id: randomUUID(),
          orderId: order.id,
          description: `Imported legacy customer row ${row.id}`,
          payload: order.rawPayload
        },
        transaction
      }
    )

    await transaction.commit()
    return { status: 'imported', orderNo: order.orderNo }
  } catch (err) {
    await transaction.rollback()
    return { status: 'failed', orderNo: order.orderNo, error: err.message }
  }
}

async function main() {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH
  const resolved = path.resolve(dbPath)
  const rows = readSqliteRows(resolved)
  let imported = 0
  let skipped = 0
  const failures = []

  await sequelize.authenticate()
  for (const row of rows) {
    const result = await importRow(row)
    if (result.status === 'imported') imported += 1
    if (result.status === 'skipped') skipped += 1
    if (result.status === 'failed') failures.push(result)
  }
  await sequelize.close()

  console.log(JSON.stringify({
    source: resolved,
    total: rows.length,
    imported,
    skipped,
    failed: failures.length,
    failures: failures.slice(0, 10)
  }, null, 2))
  if (failures.length > 0) process.exit(1)
}

main().catch(async (err) => {
  try { await sequelize.close() } catch {}
  console.error(err)
  process.exit(1)
})
