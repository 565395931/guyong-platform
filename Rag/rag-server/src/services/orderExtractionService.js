const PAYMENT_PLATFORMS = ['PayPal', '万里汇', '微信', '支付宝']
const COURIERS = ['苏州-通世', '上海-化工', '沙特-化工', '李岩-万邦', '白云-正午']

function firstMatch(text, regex) {
  const match = text.match(regex)
  return match ? String(match[1] || match[0]).trim() : ''
}

function uniq(values) {
  return [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))]
}

function normalizeLines(messages = []) {
  return messages
    .map(msg => msg.text || msg.translatedText || '')
    .join('\n')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function extractEmail(text) {
  return firstMatch(text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
}

function extractPhone(text) {
  const candidates = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) || []
  return candidates
    .map(item => item.trim())
    .find(item => item.replace(/\D/g, '').length >= 7) || ''
}

function extractLabelValue(lines, labels) {
  for (const line of lines) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = line.match(new RegExp(`^${escaped}\\s*[:：-]\\s*(.+)$`, 'i'))
      if (match?.[1]) return match[1].trim()
    }
  }
  return ''
}

function extractPaymentPlatform(text) {
  return PAYMENT_PLATFORMS.find(item => text.toLowerCase().includes(item.toLowerCase())) || ''
}

function extractCourier(text) {
  return COURIERS.find(item => text.includes(item)) || ''
}

function extractTrackingNumbers(text) {
  const candidates = text.match(/\b[A-Z0-9][A-Z0-9-]{7,35}\b/g) || []
  return uniq(candidates.filter(item => /\d/.test(item) && !/^\d{8}$/.test(item)))
}

function extractMoney(text) {
  const matches = [...text.matchAll(/(?:USD|US\$|\$)\s*([0-9]+(?:\.[0-9]+)?)/gi)]
  if (matches.length === 0) return null
  return Number(matches[matches.length - 1][1])
}

function extractProductItems(lines) {
  const productLines = lines.filter(line => {
    if (/^(email|phone|address|city|country|recipient|name)\s*[:：-]/i.test(line)) return false
    return /(\$|USD|qty|quantity|pcs|kg|ml|coating|material|tester|VLT|G\d{2,})/i.test(line)
      && /[A-Za-z]/.test(line)
  })

  return productLines.slice(0, 5).map((line, index) => {
    const qty = Number(firstMatch(line, /(?:qty|quantity|x)\s*[:：]?\s*(\d+(?:\.\d+)?)/i)) || 1
    const unitPrice = extractMoney(line)
    const description = line
      .replace(/(?:qty|quantity)\s*[:：]?\s*\d+(?:\.\d+)?/ig, '')
      .replace(/(?:USD|US\$|\$)\s*[0-9]+(?:\.[0-9]+)?/ig, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return {
      productName: description || `Imported item ${index + 1}`,
      description: description || line,
      quantity: qty,
      unitPrice,
      currency: 'USD',
      sortOrder: index
    }
  })
}

function extractOrderDraftFromMessages({ conversation = {}, recentMessages = [] }) {
  const lines = normalizeLines(recentMessages)
  const text = lines.join('\n')
  const email = extractEmail(text)
  const phone = extractPhone(text)
  const recipientName = extractLabelValue(lines, ['Recipient', 'Receiver', 'Name', '收件人', '姓名'])
  const address = extractLabelValue(lines, ['Address', '地址', 'Detailed Address', '详细地址'])
  const city = extractLabelValue(lines, ['City', '城市'])
  const country = extractLabelValue(lines, ['Country', '国家'])
  const regionAddress = [country, city].filter(Boolean).join(' ')
  const paymentPlatform = extractPaymentPlatform(text)
  const courier = extractCourier(text)
  const trackingNumbers = extractTrackingNumbers(text)
  const items = extractProductItems(lines)
  const goodsAmount = items.reduce((sum, item) => {
    if (item.unitPrice == null) return sum
    return sum + (Number(item.quantity || 1) * Number(item.unitPrice || 0))
  }, 0)

  const shipments = []
  if (trackingNumbers[0] || courier || address || city || country) {
    shipments.push({
      shipmentType: 'international',
      courier,
      trackingNo: trackingNumbers[0] || '',
      recipientName: recipientName || conversation.user_name || '',
      recipientPhone: phone || '',
      country,
      city,
      addressDetail: address,
      status: trackingNumbers[0] ? 'shipped' : 'pending'
    })
  }

  return {
    customerName: recipientName || conversation.user_name || '',
    customerPhone: phone || '',
    customerEmail: email,
    customerCountry: country,
    customerCity: city,
    customerAddress: regionAddress,
    paymentPlatform,
    goodsAmount: goodsAmount ? Number(goodsAmount.toFixed(2)) : null,
    dealAmount: goodsAmount ? Number(goodsAmount.toFixed(2)) : null,
    items,
    shipments
  }
}

module.exports = {
  extractOrderDraftFromMessages
}
