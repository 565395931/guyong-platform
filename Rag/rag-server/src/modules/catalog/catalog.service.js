const {
  normalizeProduct,
  normalizeSku,
  normalizePriceRule,
  normalizeFreightRule
} = require('./catalog.validation')

const NORMALIZERS = Object.freeze({
  product: normalizeProduct,
  sku: normalizeSku,
  price: normalizePriceRule,
  freight: normalizeFreightRule
})

const UPSERT_METHODS = Object.freeze({
  product: 'upsertProduct',
  sku: 'upsertSku',
  price: 'upsertPriceRule',
  freight: 'upsertFreightRule'
})

function createCatalogService({ repository, now = () => new Date() }) {
  async function requireDraft(versionId) {
    const version = await repository.getVersion(versionId)
    if (!version) throw new Error('catalog version not found')
    if (version.status !== 'draft') throw new Error('catalog changes require a draft version')
    return version
  }

  async function writeDraft(kind, versionId, input, userId) {
    await requireDraft(versionId)
    const normalizer = NORMALIZERS[kind]
    const method = UPSERT_METHODS[kind]
    if (!normalizer || !method) throw new Error('unsupported catalog entity')
    const normalized = normalizer(input)
    const result = await repository[method](versionId, normalized)
    await repository.writeAudit({
      entityType: kind,
      entityId: result.id,
      action: 'upsert',
      afterJson: normalized,
      operatorId: userId
    })
    return result
  }

  return {
    listVersions: () => repository.listVersions(),
    createDraft: userId => repository.createDraftFromPublished(userId, now()),
    listProducts: versionId => repository.listProducts(versionId),
    listSkus: versionId => repository.listSkus(versionId),
    listPriceRules: versionId => repository.listPriceRules(versionId),
    listFreightRules: versionId => repository.listFreightRules(versionId),
    upsertProduct: (versionId, input, userId) => writeDraft('product', versionId, input, userId),
    upsertSku: (versionId, input, userId) => writeDraft('sku', versionId, input, userId),
    upsertPriceRule: (versionId, input, userId) => writeDraft('price', versionId, input, userId),
    upsertFreightRule: (versionId, input, userId) => writeDraft('freight', versionId, input, userId),

    async applyImport(versionId, preview, userId) {
      for (const row of preview.products || []) await writeDraft('product', versionId, row, userId)
      for (const row of preview.skus || []) await writeDraft('sku', versionId, row, userId)
      for (const row of preview.priceRules || []) await writeDraft('price', versionId, row, userId)
      for (const row of preview.freightRules || []) await writeDraft('freight', versionId, row, userId)
      return { versionId }
    },

    async publishVersion(versionId, userId) {
      await requireDraft(versionId)
      return repository.transaction(async transaction => {
        await repository.retirePublished(transaction)
        await repository.publishVersion(versionId, userId, transaction)
        await repository.writeAudit({
          entityType: 'catalog_version',
          entityId: versionId,
          action: 'publish',
          operatorId: userId,
          transaction
        })
        return repository.getVersion(versionId, transaction)
      })
    }
  }
}

module.exports = { createCatalogService }
