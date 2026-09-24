const fs = require('fs')
const path = require('path')

const { parseCatalogBuffer } = require('../src/modules/catalog/catalog.import.service')

const input = process.argv[2]

if (!input) {
  console.error('用法: node scripts/preview-catalog-import.js <文件路径>')
  process.exitCode = 1
} else {
  const filename = path.resolve(input)
  const preview = parseCatalogBuffer({
    filename,
    buffer: fs.readFileSync(filename)
  })

  console.log(JSON.stringify({
    filename: path.basename(filename),
    sourceHash: preview.sourceHash,
    accepted: preview.accepted,
    products: preview.products.length,
    skus: preview.skus.length,
    priceRules: preview.priceRules.length,
    freightRules: preview.freightRules.length,
    warnings: preview.warnings
  }, null, 2))
}
