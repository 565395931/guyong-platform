const test = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { parseCatalogBuffer, createImportService } = require('./catalog.import.service')

test('extracts products, SKUs, prices and freight from Markdown', async () => {
  const markdown = Buffer.from(`# Price and freight
### 零售价格
| 规格 | 重量 | 美元价 |
|---|---|---|
| 500ml | 0.5kg | $100 |

### 批发价格
| 规格 | 美元价 |
|---|---|
| 10kg+ | $160/kg |

### 通用运费规则
| 区域 | 基础运费 | 每增加500g |
|---|---|---|
| 默认（其他国家） | $85 | +$15 |
| 美国 | $40 | +$10 |
`, 'utf8')

  const preview = await parseCatalogBuffer({ filename: 'price.md', buffer: markdown })

  assert.equal(preview.accepted, true)
  assert.equal(preview.products.length, 1)
  assert.equal(preview.skus.length, 2)
  assert.equal(preview.priceRules.length, 2)
  assert.equal(preview.priceRules[0].unitPrice, 100)
  assert.equal(preview.priceRules[1].minQuantity, 10)
  assert.equal(preview.freightRules.length, 2)
  assert.equal(preview.freightRules[0].baseFee, 85)
})

test('accepts only named catalog sheets in Excel', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(['brand', 'usage'])
  sheet.addRow(['Example', 'Glass'])
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

  const preview = await parseCatalogBuffer({ filename: 'catalog.xlsx', buffer })

  assert.equal(preview.accepted, false)
  assert.equal(preview.priceRules.length, 0)
  assert.match(preview.warnings[0], /Products/)
})

test('rejects Markdown without catalog tables', async () => {
  const preview = await parseCatalogBuffer({
    filename: 'faq.md',
    buffer: Buffer.from('# FAQ\n\nThere is no catalog table here.', 'utf8')
  })

  assert.equal(preview.accepted, false)
  assert.equal(preview.products.length, 0)
  assert.equal(preview.skus.length, 0)
  assert.equal(preview.priceRules.length, 0)
  assert.equal(preview.freightRules.length, 0)
})

test('duplicate source hashes cannot create a second draft', async () => {
  const jobs = []
  const repository = {
    findCommittedImportByHash: async () => ({ committed_version_id: 'published-1' }),
    createImportJob: async row => { jobs.push(row); return { id: 'job-1', ...row } }
  }
  const service = createImportService({
    repository,
    catalogService: { createDraft: async () => { throw new Error('must not create draft') } }
  })

  const result = await service.preview({
    originalname: 'price.md',
    buffer: Buffer.from('# empty', 'utf8')
  }, 9)

  assert.equal(result.status, 'duplicate')
  assert.equal(result.previewJson.accepted, false)
  assert.match(result.previewJson.warnings[0], /published-1/)
  assert.equal(jobs.length, 1)
})

test('committing a preview applies it to a fresh draft', async () => {
  const calls = []
  const service = createImportService({
    repository: {
      getImportJob: async () => ({
        id: 'job-1',
        status: 'previewed',
        preview_json: { products: [], skus: [], priceRules: [], freightRules: [] }
      }),
      markImportCommitted: async (...args) => calls.push(['committed', ...args])
    },
    catalogService: {
      createDraft: async () => ({ id: 'draft-1' }),
      applyImport: async (...args) => calls.push(['applied', ...args])
    }
  })

  const version = await service.commit('job-1', 9)

  assert.equal(version.id, 'draft-1')
  assert.deepEqual(calls.map(row => row[0]), ['applied', 'committed'])
})
