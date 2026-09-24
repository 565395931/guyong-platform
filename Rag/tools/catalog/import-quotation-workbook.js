const dotenv = require('../../rag-server/node_modules/dotenv')
const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const ExcelJS = require('../../rag-server/node_modules/exceljs')

dotenv.config({ path: path.resolve(__dirname, '../../rag-server/.env') })

const { sequelize } = require('../../rag-server/src/config/database')
const { ensureCatalogSchema } = require('../../rag-server/src/modules/catalog/catalog.schema')
const { createRepository } = require('../../rag-server/src/modules/catalog/catalog.repository')
const { createCatalogService } = require('../../rag-server/src/modules/catalog/catalog.service')
const { parseQuoteSheet, extractQuoteImages } = require('../../rag-server/src/modules/catalog/quoteWorkbook')

const MEDIA_DIR = path.resolve(__dirname, '../../rag-server/src/public/media-files')
const PUBLIC_PREFIX = '/api/media-files/static'
const OPERATOR_ID = Number(process.env.CATALOG_IMPORT_OPERATOR_ID || 1)

function mimeType(extension) {
  return extension.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg'
}

async function saveMedia(image, sourceHash, productCode) {
  const extension = image.extension.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const filename = `catalog-${sourceHash.slice(0, 16)}-${productCode}.${extension}`
  await fs.mkdir(MEDIA_DIR, { recursive: true })
  const storagePath = path.join(MEDIA_DIR, filename)
  await fs.writeFile(storagePath, image.buffer)
  return {
    id: crypto.randomUUID(),
    filename,
    storagePath,
    url: `${PUBLIC_PREFIX}/${filename}`,
    mimeType: mimeType(extension),
    size: image.buffer.length
  }
}

async function main() {
  const sourceArg = process.argv[2]
  if (!sourceArg) throw new Error('usage: node tools/catalog/import-quotation-workbook.js <xlsx-path>')
  const sourcePath = path.resolve(sourceArg)
  const buffer = await fs.readFile(sourcePath)
  const sourceHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const parsed = parseQuoteSheet(workbook, path.basename(sourcePath))
  if (!parsed?.accepted) throw new Error('quotation workbook has no importable product rows')

  await sequelize.authenticate()
  await ensureCatalogSchema(sequelize)
  const repository = createRepository(sequelize)
  const catalogService = createCatalogService({ repository })
  const existing = await repository.findCommittedImportByHash(sourceHash)
  if (existing) {
    console.log(`IMPORT_SKIPPED sourceHash=${sourceHash} version=${existing.committed_version_id}`)
    return
  }

  const images = extractQuoteImages(workbook, parsed.imageAssets)
  const imageRows = []
  const stagedFiles = []
  const imageByProduct = new Map()
  const previewJson = {
    ...parsed,
    imageAssets: parsed.imageAssets.map(asset => ({ ...asset })),
    warnings: [...parsed.warnings]
  }
  const job = await repository.createImportJob({
    filename: path.basename(sourcePath),
    sourceHash,
    status: 'previewed',
    previewJson,
    createdBy: OPERATOR_ID
  })

  try {
    for (const image of images) {
      const productCode = image.productCode
      const saved = await saveMedia(image, sourceHash, productCode)
      stagedFiles.push(saved.storagePath)
      const mediaId = saved.id
      await sequelize.query(
        `INSERT INTO media_files
          (id, original_name, display_name, description, filename, media_type, mime_type, size, storage_path, url, uploader_id, created_at, updated_at)
         VALUES (:id, :originalName, :displayName, :description, :filename, 'image', :mimeType, :size, :storagePath, :url, :uploaderId, NOW(), NOW())`,
        {
          replacements: {
            id: mediaId,
            originalName: `${productCode}.${saved.filename.split('.').pop()}`,
            displayName: `报价商品图片 ${productCode}`,
            description: `Imported from ${path.basename(sourcePath)}`,
            filename: saved.filename,
            mimeType: saved.mimeType,
            size: saved.size,
            storagePath: saved.storagePath,
            url: saved.url,
            uploaderId: OPERATOR_ID
          }
        }
      )
      imageRows.push({ mediaId, productCode, url: saved.url })
      imageByProduct.set(productCode, { mediaId, url: saved.url })
    }

    const version = await catalogService.createDraft(OPERATOR_ID)
    const products = parsed.products.map(product => ({
      ...product,
      ...(imageByProduct.get(product.productCode)
        ? {
            imageMediaId: imageByProduct.get(product.productCode).mediaId,
            imageUrl: imageByProduct.get(product.productCode).url
          }
        : {})
    }))
    await catalogService.applyImport(version.id, {
      ...parsed,
      products,
      imageAssets: undefined
    }, OPERATOR_ID)
    await catalogService.publishVersion(version.id, OPERATOR_ID)
    await repository.markImportCommitted(job.id, version.id)

    console.log(JSON.stringify({
      status: 'pass',
      source: path.basename(sourcePath),
      sourceHash,
      versionId: version.id,
      products: products.length,
      skus: parsed.skus.length,
      prices: parsed.priceRules.length,
      images: imageRows.length,
      warnings: parsed.warnings
    }))
  } catch (error) {
    for (const storagePath of stagedFiles) {
      try { await fs.unlink(storagePath) } catch { /* best effort cleanup */ }
    }
    if (imageRows.length) {
      await sequelize.query(
        `DELETE FROM media_files WHERE id IN (${imageRows.map(() => '?').join(',')})`,
        { replacements: imageRows.map(row => row.mediaId) }
      )
    }
    throw error
  }
}

main()
  .catch(error => {
    console.error(`IMPORT_FAIL ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await sequelize.close()
  })
