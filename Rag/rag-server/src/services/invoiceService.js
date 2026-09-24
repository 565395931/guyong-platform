const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'generated-invoices')
const PUBLIC_PREFIX = '/api/invoices/static'

const DEFAULT_COMPANY = {
  name: 'Lonely Brave (Changzhou) New Material Technology Co.',
  email: '527069983@qq.com',
  phone: '+86 18494444999',
  address_line1: 'No. 26, Changjiang North Road, Xinbei',
  address_line2: '213000, Changzhou, Jiangsu, CHINA'
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }
}

function parseDate(value) {
  if (!value) return new Date()
  const parsed = new Date(String(value).replace(/\./g, '-').replace(/\//g, '-'))
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

function formatDate(value) {
  const d = parseDate(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function compactDate(value) {
  return formatDate(value).replace(/-/g, '')
}

function money(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n : 0
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeProducts(products = []) {
  if (!Array.isArray(products)) return []
  return products
    .map((item) => {
      const description = String(item.description || item.product_name || item.productName || '').trim()
      if (!description) return null
      const qty = money(item.qty ?? item.quantity ?? 1) || 1
      const unitValue = money(item.unit_value ?? item.unitPrice ?? item.unit_price)
      return {
        description,
        qty,
        unit_value: unitValue,
        total: Number((qty * unitValue).toFixed(2))
      }
    })
    .filter(Boolean)
}

function normalizeInvoiceData(data = {}) {
  const products = normalizeProducts(data.products)
  const currency = data.currency || 'USD'
  const shipping = data.shipping === '' || data.shipping === undefined || data.shipping === null
    ? null
    : money(data.shipping)
  const subtotal = products.reduce((sum, item) => sum + item.total, 0)
  const total = Number((subtotal + (shipping || 0)).toFixed(2))

  return {
    invoice_date: formatDate(data.invoice_date),
    currency,
    company: { ...DEFAULT_COMPANY, ...(data.company || {}) },
    receiver: data.receiver || {},
    products,
    shipping,
    subtotal: Number(subtotal.toFixed(2)),
    total
  }
}

function buildHtml(data, invoiceNo) {
  const receiver = data.receiver || {}
  const company = data.company || DEFAULT_COMPANY
  const productRows = data.products.map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(item.description)}</td>
      <td class="num">${item.qty}</td>
      <td class="num">${item.unit_value.toFixed(2)} ${escapeHtml(data.currency)}</td>
      <td class="num">${item.total.toFixed(2)} ${escapeHtml(data.currency)}</td>
    </tr>
  `).join('')
  const shippingRow = data.shipping === null ? '' : `
    <tr>
      <td colspan="4" class="total-label">Shipping</td>
      <td class="num">${data.shipping.toFixed(2)} ${escapeHtml(data.currency)}</td>
    </tr>
  `

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PI_${invoiceNo}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 40px; }
    .top { display: flex; justify-content: space-between; gap: 32px; border-bottom: 2px solid #111827; padding-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    .muted { color: #6b7280; line-height: 1.5; }
    .box { margin-top: 24px; padding: 16px; border: 1px solid #d1d5db; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; }
    th, td { border: 1px solid #d1d5db; padding: 10px; font-size: 13px; vertical-align: top; }
    th { background: #f3f4f6; text-align: left; }
    .num { text-align: right; white-space: nowrap; }
    .total-label { text-align: right; font-weight: 700; }
    .grand { font-weight: 700; background: #f9fafb; }
    .payment { margin-top: 28px; line-height: 1.6; font-size: 13px; }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <h1>Proforma Invoice</h1>
      <div class="muted">
        <strong>${escapeHtml(company.name)}</strong><br>
        ${escapeHtml(company.email)}<br>
        ${escapeHtml(company.phone)}
      </div>
    </div>
    <div class="muted">
      <strong>PI # ${invoiceNo}</strong><br>
      Invoice date: ${escapeHtml(data.invoice_date)}<br>
      ${escapeHtml(company.address_line1)}<br>
      ${escapeHtml(company.address_line2)}
    </div>
  </div>

  <div class="box">
    <h2>Receiver</h2>
    <div class="muted">
      ${escapeHtml(receiver.type || '')}<br>
      ${escapeHtml(receiver.name || '')}<br>
      Email: ${escapeHtml(receiver.email || '')}<br>
      Phone: ${escapeHtml(receiver.phone || '')}<br>
      Address: ${escapeHtml(receiver.address || '')}<br>
      City: ${escapeHtml(receiver.city || '')}<br>
      Country: ${escapeHtml(receiver.country || '')}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 48px;">#</th>
        <th>Description</th>
        <th class="num">QTY</th>
        <th class="num">Unit Value</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>
      ${productRows}
      <tr>
        <td colspan="4" class="total-label">Total Declared Value</td>
        <td class="num">${data.subtotal.toFixed(2)} ${escapeHtml(data.currency)}</td>
      </tr>
      ${shippingRow}
      <tr class="grand">
        <td colspan="4" class="total-label">Total</td>
        <td class="num">${data.total.toFixed(2)} ${escapeHtml(data.currency)}</td>
      </tr>
    </tbody>
  </table>

  <div class="payment">
    <strong>Payment information</strong><br>
    Bank: JP Morgan Chase, HONG KONG BRANCH<br>
    Account name: Lonely Brave<br>
    Account No.: 63115260499
  </div>
</body>
</html>`
}

function toPdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
}

function pdfEscape(value) {
  return toPdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function wrapText(value, max = 86) {
  const text = toPdfText(value)
  const chunks = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max)
    if (cut < 30) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.length ? chunks : ['']
}

function buildPdfBuffer(data, invoiceNo) {
  const lines = []
  const push = (text = '', size = 10) => lines.push({ text, size })
  const receiver = data.receiver || {}
  const company = data.company || DEFAULT_COMPANY

  push('PROFORMA INVOICE', 18)
  push(`PI # ${invoiceNo}`, 12)
  push(`Invoice date: ${data.invoice_date}`, 10)
  push('')
  push(company.name, 12)
  push(company.email)
  push(company.phone)
  push(company.address_line1)
  push(company.address_line2)
  push('')
  push('Receiver', 12)
  ;[
    receiver.type,
    receiver.name,
    `Email: ${receiver.email || ''}`,
    `Phone: ${receiver.phone || ''}`,
    `Address: ${receiver.address || ''}`,
    `City: ${receiver.city || ''}`,
    `Country: ${receiver.country || ''}`
  ].forEach((line) => wrapText(line).forEach((part) => push(part)))
  push('')
  push('Products', 12)
  data.products.forEach((item, index) => {
    wrapText(`${index + 1}. ${item.description}`).forEach((part) => push(part))
    push(`   QTY: ${item.qty}    Unit: ${item.unit_value.toFixed(2)} ${data.currency}    Total: ${item.total.toFixed(2)} ${data.currency}`)
  })
  push('')
  push(`Total Declared Value: ${data.subtotal.toFixed(2)} ${data.currency}`, 12)
  if (data.shipping !== null) push(`Shipping: ${data.shipping.toFixed(2)} ${data.currency}`, 12)
  push(`Total: ${data.total.toFixed(2)} ${data.currency}`, 14)
  push('')
  push('Payment information', 12)
  push('Bank: JP Morgan Chase, HONG KONG BRANCH')
  push('Account name: Lonely Brave')
  push('Account No.: 63115260499')

  let y = 790
  const content = ['BT', '/F1 10 Tf']
  for (const line of lines) {
    if (y < 40) break
    content.push(`/F1 ${line.size} Tf`)
    content.push(`1 0 0 1 50 ${y} Tm (${pdfEscape(line.text)}) Tj`)
    y -= Math.max(14, line.size + 4)
  }
  content.push('ET')
  const stream = content.join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(pdf, 'binary')
}

async function nextInvoiceNo(sequelize, invoiceDate, transaction) {
  const counterDate = formatDate(invoiceDate)
  await sequelize.query(
    `INSERT INTO invoice_counters (counter_date, seq, updated_at)
     VALUES (:counterDate, LAST_INSERT_ID(1), NOW())
     ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1), updated_at = NOW()`,
    { replacements: { counterDate }, transaction }
  )
  const [rows] = await sequelize.query('SELECT LAST_INSERT_ID() AS seq', { transaction })
  const seq = Number(rows[0]?.seq || 1)
  return `${compactDate(counterDate)}${String(seq).padStart(3, '0')}`
}

async function buildInvoiceDataFromOrder(sequelize, orderId) {
  const [orders] = await sequelize.query(
    'SELECT * FROM orders WHERE id = :orderId LIMIT 1',
    { replacements: { orderId } }
  )
  if (orders.length === 0) {
    const err = new Error('订单不存在')
    err.status = 404
    throw err
  }
  const order = orders[0]
  const [items] = await sequelize.query(
    'SELECT * FROM order_items WHERE order_id = :orderId ORDER BY sort_order ASC, created_at ASC',
    { replacements: { orderId } }
  )
  const [shipments] = await sequelize.query(
    'SELECT * FROM order_shipments WHERE order_id = :orderId ORDER BY created_at ASC',
    { replacements: { orderId } }
  )
  const shipment = shipments[0] || {}
  return normalizeInvoiceData({
    invoice_date: new Date(),
    currency: order.currency || 'USD',
    shipping: order.shipping_amount,
    receiver: {
      type: order.customer_name || '',
      name: shipment.recipient_name || order.customer_name || '',
      email: order.customer_email || '',
      phone: shipment.recipient_phone || order.customer_phone || '',
      address: shipment.address_detail || order.customer_address || '',
      city: shipment.city || order.customer_city || '',
      country: shipment.country || order.customer_country || ''
    },
    products: items.map((item) => ({
      description: item.description || item.product_name,
      qty: item.quantity,
      unit_value: item.unit_price
    }))
  })
}

async function generateInvoiceFiles({ sequelize, data, orderId = null, userId = null, transaction = null }) {
  ensureOutputDir()
  const invoiceData = normalizeInvoiceData(data)
  if (invoiceData.products.length === 0) {
    const err = new Error('发票至少需要一个商品')
    err.status = 400
    throw err
  }
  const invoiceNo = await nextInvoiceNo(sequelize, invoiceData.invoice_date, transaction)
  const baseName = `PI_${invoiceNo}`
  const htmlPath = path.join(OUTPUT_DIR, `${baseName}.html`)
  const pdfPath = path.join(OUTPUT_DIR, `${baseName}.pdf`)
  const jsonPath = path.join(OUTPUT_DIR, `${baseName}.json`)
  const html = buildHtml(invoiceData, invoiceNo)
  const pdf = buildPdfBuffer(invoiceData, invoiceNo)

  fs.writeFileSync(htmlPath, html, 'utf8')
  fs.writeFileSync(pdfPath, pdf)
  fs.writeFileSync(jsonPath, JSON.stringify(invoiceData, null, 2), 'utf8')

  const invoiceId = randomUUID()
  const publicUrl = `${PUBLIC_PREFIX}/${path.basename(pdfPath)}`
  await sequelize.query(
    `INSERT INTO order_invoices
      (id, order_id, invoice_no, invoice_date, currency, subtotal_amount, shipping_amount, total_amount,
       receiver_json, products_json, pdf_path, html_path, json_path, public_url, generated_by, created_at, updated_at)
     VALUES
      (:id, :orderId, :invoiceNo, :invoiceDate, :currency, :subtotalAmount, :shippingAmount, :totalAmount,
       :receiverJson, :productsJson, :pdfPath, :htmlPath, :jsonPath, :publicUrl, :generatedBy, NOW(), NOW())`,
    {
      replacements: {
        id: invoiceId,
        orderId,
        invoiceNo,
        invoiceDate: invoiceData.invoice_date,
        currency: invoiceData.currency,
        subtotalAmount: invoiceData.subtotal,
        shippingAmount: invoiceData.shipping,
        totalAmount: invoiceData.total,
        receiverJson: JSON.stringify(invoiceData.receiver || {}),
        productsJson: JSON.stringify(invoiceData.products || []),
        pdfPath,
        htmlPath,
        jsonPath,
        publicUrl,
        generatedBy: userId
      },
      transaction
    }
  )

  return {
    id: invoiceId,
    invoiceNo,
    invoiceDate: invoiceData.invoice_date,
    currency: invoiceData.currency,
    subtotalAmount: invoiceData.subtotal,
    shippingAmount: invoiceData.shipping,
    totalAmount: invoiceData.total,
    pdfPath,
    htmlPath,
    jsonPath,
    publicUrl
  }
}

module.exports = {
  DEFAULT_COMPANY,
  OUTPUT_DIR,
  PUBLIC_PREFIX,
  buildInvoiceDataFromOrder,
  generateInvoiceFiles,
  normalizeInvoiceData
}
