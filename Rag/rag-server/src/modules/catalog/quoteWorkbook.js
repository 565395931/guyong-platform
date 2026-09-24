const crypto = require('crypto')

function cellText(value) {
  if (value && typeof value === 'object' && 'result' in value) return String(value.result ?? '').trim()
  if (value && typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text || '').join('').trim()
  }
  return String(value ?? '').trim()
}

function parsePrice(value) {
  const match = cellText(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function stableCode(prefix, name, rowNumber) {
  const digest = crypto.createHash('sha1').update(`${rowNumber}:${name}`).digest('hex').slice(0, 8).toUpperCase()
  return `${prefix}-${String(rowNumber).padStart(2, '0')}-${digest}`
}

function coverageFromName(name) {
  const match = name.match(/[（(][^）)]*?(\d+(?:\.\d+)?)\s*(?:-|~|至)?\s*(\d+(?:\.\d+)?)?\s*(?:平方|平米|㎡)[^）)]*[）)]/i)
  if (!match) return { min: null, max: null }
  const min = Number(match[1])
  const max = match[2] ? Number(match[2]) : min
  return { min, max }
}

function specificationFromName(name) {
  const match = name.match(/[（(]([^）)]+)[）)]/)
  return match ? match[1].trim() : name.match(/\d+(?:\.\d+)?\s*(?:ml|毫升)/i)?.[0] || null
}

function isQuoteSheet(sheet) {
  const headers = sheet.getRow(1).values.slice(1).map(cellText)
  return headers.some(header => /产品名称|商品名称|product\s*name/i.test(header))
    && headers.some(header => /价格|报价|price/i.test(header))
}

function parseQuoteSheet(workbook, filename = 'quotation.xlsx') {
  const sheet = workbook.worksheets.find(isQuoteSheet)
  if (!sheet) return null

  const headers = sheet.getRow(1).values.slice(1).map(cellText)
  const nameIndex = headers.findIndex(header => /产品名称|商品名称|product\s*name/i.test(header))
  const priceIndex = headers.findIndex(header => /价格|报价|price/i.test(header))
  const products = []
  const skus = []
  const priceRules = []
  const imageAssets = []
  const warnings = ['未发现币种列，报价按 CNY 导入；请在正式发布前确认币种。']

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = sheet.getRow(rowNumber).values.slice(1)
    const name = cellText(values[nameIndex])
    if (!name) continue
    const unitPrice = parsePrice(values[priceIndex])
    if (!(unitPrice > 0)) {
      warnings.push(`第 ${rowNumber} 行价格无法识别，已跳过：${name}`)
      continue
    }

    const productCode = stableCode('QTE-P', name, rowNumber)
    const skuCode = stableCode('QTE-S', name, rowNumber)
    const coverage = coverageFromName(name)
    const specification = specificationFromName(name)
    products.push({
      productCode,
      name,
      description: `报价表导入：${filename}，原始行 ${rowNumber}`,
      status: 'active'
    })
    skus.push({
      productCode,
      skuCode,
      specification,
      packaging: specification,
      coverageMinSqm: coverage.min,
      coverageMaxSqm: coverage.max,
      status: 'active'
    })
    priceRules.push({
      skuCode,
      customerType: 'all',
      minQuantity: 1,
      maxQuantity: null,
      unit: 'piece',
      currency: 'CNY',
      unitPrice,
      status: 'active'
    })
    imageAssets.push({ productCode, rowNumber })
  }

  return { accepted: products.length > 0, products, skus, priceRules, freightRules: [], imageAssets, warnings }
}

function extractQuoteImages(workbook, imageAssets) {
  const sheet = workbook.worksheets.find(isQuoteSheet)
  if (!sheet) return []
  const sortedImages = sheet.getImages().sort((left, right) => (left.range?.tl?.nativeRow || 0) - (right.range?.tl?.nativeRow || 0))
  const sortedAssets = [...imageAssets].sort((left, right) => left.rowNumber - right.rowNumber)
  return sortedImages.flatMap((image, index) => {
    const asset = sortedAssets[index]
    if (!asset) return []
    const media = workbook.getImage(image.imageId)
    const buffer = media?.buffer
      ? Buffer.from(media.buffer)
      : media?.base64
        ? Buffer.from(String(media.base64).replace(/^data:[^;]+;base64,/, ''), 'base64')
        : null
    if (!buffer?.length) return []
    return [{
      productCode: asset.productCode,
      rowNumber: asset.rowNumber,
      extension: media.extension || 'bin',
      buffer
    }]
  })
}

module.exports = { parseQuoteSheet, extractQuoteImages, parsePrice, coverageFromName, stableCode }
