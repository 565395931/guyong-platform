const crypto = require('crypto')
const path = require('path')
const ExcelJS = require('exceljs')
const { parseQuoteSheet } = require('./quoteWorkbook')

function parseMoney(value) {
  const match = String(value || '').replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cell => cell.trim())
}

function rowsFromMarkdownTables(text) {
  const lines = String(text || '').split(/\r?\n/)
  const tables = []
  let heading = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^#{1,4}\s+/.test(line)) {
      heading = line.replace(/^#{1,4}\s+/, '').trim()
    }
    const separator = lines[index + 1] || ''
    if (!/^\s*\|/.test(line) || !/^\s*\|[-:\s|]+\|?\s*$/.test(separator)) continue

    const headers = splitMarkdownRow(line)
    const rows = []
    index += 2
    while (index < lines.length && /^\s*\|/.test(lines[index])) {
      const cells = splitMarkdownRow(lines[index])
      rows.push(Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] || ''])))
      index += 1
    }
    tables.push({ heading, headers, rows })
    index -= 1
  }
  return tables
}

function skuCodeForSpecification(specification) {
  return `COATING-${String(specification)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase()}`
}

function normalizeRegionCode(value) {
  const text = String(value || '').trim()
  if (/默认|其他国家/i.test(text)) return 'DEFAULT'
  const map = {
    美国: 'US', 加拿大: 'CA', 印度: 'IN', 泰国: 'TH', 土耳其: 'TR',
    乌兹别克斯坦: 'UZ', 叙利亚: 'SY', 埃及: 'EG', 哈萨克斯坦: 'KZ',
    伊拉克: 'IQ', 墨西哥: 'MX', 斯洛伐克: 'SK', 白俄罗斯: 'BY',
    希腊: 'GR', 伊朗: 'IR', 新加坡: 'SG', 阿联酋: 'AE', 沙特阿拉伯: 'SA'
  }
  return map[text] || text.toUpperCase()
}

function parseMarkdown(text) {
  const result = {
    products: [],
    skus: [],
    priceRules: [],
    freightRules: [],
    warnings: []
  }
  const productCodes = new Set()
  const skuCodes = new Set()

  for (const table of rowsFromMarkdownTables(text)) {
    if (/零售价格|批发价格/.test(table.heading)) {
      const wholesale = /批发价格/.test(table.heading)
      for (const row of table.rows) {
        const specification = row['规格'] || row['重量']
        const unitPrice = parseMoney(row['美元价'])
        if (!specification || !(unitPrice > 0)) {
          result.warnings.push(`跳过无法识别的价格行：${JSON.stringify(row)}`)
          continue
        }

        const quantityMatch = specification.match(/(\d+(?:\.\d+)?)\s*kg\+?/i)
        const minQuantity = wholesale && quantityMatch ? Number(quantityMatch[1]) : 1
        const skuCode = skuCodeForSpecification(specification)
        if (!productCodes.has('GLASS-COATING')) {
          result.products.push({
            productCode: 'GLASS-COATING',
            name: '纳米陶瓷玻璃隔热镀膜涂层',
            description: '由价格资料导入',
            status: 'active'
          })
          productCodes.add('GLASS-COATING')
        }
        if (!skuCodes.has(skuCode)) {
          result.skus.push({
            productCode: 'GLASS-COATING',
            skuCode,
            specification,
            packaging: specification,
            status: 'active'
          })
          skuCodes.add(skuCode)
        }
        result.priceRules.push({
          skuCode,
          customerType: wholesale ? 'wholesale' : 'retail',
          minQuantity,
          maxQuantity: null,
          unit: /ml/i.test(specification) ? 'ml' : 'kg',
          currency: 'USD',
          unitPrice
        })
      }
    }

    if (/通用运费规则|具体国家运费速查/.test(table.heading)) {
      for (const row of table.rows) {
        const region = row['国家'] || row['区域']
        if (!region) continue
        const baseFee = parseMoney(row['运费'] || row['基础运费'])
        result.freightRules.push({
          regionCode: normalizeRegionCode(region),
          deliveryTerm: 'OTHER',
          baseWeightKg: 0.5,
          baseFee,
          incrementalWeightKg: 0.5,
          incrementalFee: parseMoney(row['每增加500g']),
          currency: 'USD',
          manualConfirmation: baseFee == null
        })
      }
    }
  }

  if (!result.priceRules.length && !result.freightRules.length) {
    result.warnings.push('未识别到产品价格或运费表格')
  }
  return result
}

function cellValue(value) {
  if (value && typeof value === 'object' && 'result' in value) return value.result ?? null
  if (value && typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text || '').join('')
  }
  return value ?? null
}

function rowsFromSheet(workbook, name) {
  const sheet = workbook.getWorksheet(name)
  if (!sheet || sheet.rowCount < 1) return []
  const headers = sheet.getRow(1).values.slice(1).map(value => String(cellValue(value) || '').trim())
  const rows = []
  for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const values = sheet.getRow(rowIndex).values.slice(1)
    if (!values.some(value => cellValue(value) != null)) continue
    rows.push(Object.fromEntries(headers.map((header, index) => [header, cellValue(values[index])])))
  }
  return rows
}

async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const allowed = new Set(['Products', 'SKUs', 'Prices', 'Freight'])
  const recognized = workbook.worksheets.map(sheet => sheet.name).filter(name => allowed.has(name))
  if (!recognized.length) {
    const quote = parseQuoteSheet(workbook)
    if (quote) return quote
    return {
      accepted: false,
      products: [],
      skus: [],
      priceRules: [],
      freightRules: [],
      warnings: ['未找到 Products、SKUs、Prices 或 Freight 工作表']
    }
  }
  return {
    accepted: true,
    products: rowsFromSheet(workbook, 'Products'),
    skus: rowsFromSheet(workbook, 'SKUs'),
    priceRules: rowsFromSheet(workbook, 'Prices'),
    freightRules: rowsFromSheet(workbook, 'Freight'),
    warnings: []
  }
}

async function parseCatalogBuffer({ filename, buffer }) {
  const sourceHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = path.extname(filename).toLowerCase()
  let parsed
  try {
    if (extension === '.md') {
      parsed = { accepted: true, ...parseMarkdown(buffer.toString('utf8')) }
    } else if (extension === '.xlsx' || extension === '.xls') {
      parsed = await parseWorkbook(buffer)
    } else {
      parsed = {
        accepted: false,
        products: [],
        skus: [],
        priceRules: [],
        freightRules: [],
        warnings: ['不支持的文件类型']
      }
    }
  } catch (error) {
    parsed = {
      accepted: false,
      products: [],
      skus: [],
      priceRules: [],
      freightRules: [],
      warnings: [`文件解析失败：${error.message}`]
    }
  }
  const rowCount = ['products', 'skus', 'priceRules', 'freightRules']
    .reduce((total, key) => total + (parsed[key]?.length || 0), 0)
  if (parsed.accepted && rowCount === 0) {
    parsed.accepted = false
    if (!parsed.warnings.length) parsed.warnings.push('未识别到可导入的目录数据')
  }
  return { sourceHash, ...parsed }
}

function createImportService({ repository, catalogService }) {
  return {
    async preview(file, userId) {
      if (!file?.buffer || !file.originalname) throw new Error('catalog import file is required')
      const parsed = await parseCatalogBuffer({ filename: file.originalname, buffer: file.buffer })
      const committed = await repository.findCommittedImportByHash(parsed.sourceHash)
      if (committed) {
        return repository.createImportJob({
          filename: file.originalname,
          sourceHash: parsed.sourceHash,
          status: 'duplicate',
          previewJson: {
            ...parsed,
            accepted: false,
            warnings: [`相同文件已导入版本 ${committed.committed_version_id}`, ...parsed.warnings]
          },
          createdBy: userId
        })
      }
      return repository.createImportJob({
        filename: file.originalname,
        sourceHash: parsed.sourceHash,
        status: parsed.accepted ? 'previewed' : 'rejected',
        previewJson: parsed,
        createdBy: userId
      })
    },

    async commit(jobId, userId) {
      const job = await repository.getImportJob(jobId)
      if (!job || job.status !== 'previewed') throw new Error('import job is not ready')
      const version = await catalogService.createDraft(userId)
      await catalogService.applyImport(version.id, job.preview_json, userId)
      await repository.markImportCommitted(jobId, version.id)
      return version
    }
  }
}

module.exports = {
  parseMoney,
  rowsFromMarkdownTables,
  parseMarkdown,
  parseWorkbook,
  parseCatalogBuffer,
  createImportService
}
