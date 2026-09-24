# Catalog and Pricing Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working vertical slice in which authorized staff import existing product/price files, edit products, SKUs, prices and freight in `platform-web`, publish a version, and resolve an exact auditable quote from MySQL.

**Architecture:** Add a focused `catalog` module to `rag-server` with idempotent schema creation, repository, domain service, import preview/commit, publication and exact quote resolution. Add a real catalog page to `platform-web`; it talks only to `/api/v1/catalog` and never edits server files directly. Published catalog versions are immutable runtime truth; drafts remain editable and quote resolution reads only the active published version.

**Tech Stack:** Node.js CommonJS, Express, Sequelize/MySQL, built-in `node:test`, Multer, `xlsx`, Vue 3, Element Plus, Axios, Vite.

---

## Scope and file map

This plan is Phase 1A only. It deliberately excludes the enterprise WeChat adapter, AI message-routing hook, after-sales tickets, customer profiles and replacement of every mock administration page. Those are separate executable plans after this vertical slice is accepted.

Server files:

- Create `rag-server/src/modules/catalog/catalog.constants.js`: statuses, roles and supported units.
- Create `rag-server/src/modules/catalog/catalog.validation.js`: normalized input and validation errors.
- Create `rag-server/src/modules/catalog/catalog.schema.js`: idempotent MySQL tables and indexes.
- Create `rag-server/src/modules/catalog/catalog.repository.js`: all catalog SQL access.
- Create `rag-server/src/modules/catalog/catalog.service.js`: draft lifecycle, CRUD, publication and audit orchestration.
- Create `rag-server/src/modules/catalog/quote.service.js`: exact published-version quote matching.
- Create `rag-server/src/modules/catalog/catalog.import.service.js`: Markdown/Excel parsing, preview persistence and commit.
- Create `rag-server/src/modules/catalog/catalog.routes.js`: authenticated REST API.
- Create focused `*.test.js` files beside each domain unit.
- Modify `rag-server/src/config/database.js`: call the catalog schema initializer after connection.
- Modify `rag-server/src/app.js`: mount `/api/v1/catalog`.
- Modify `rag-server/package.json`: add catalog test scripts.

Frontend files:

- Create `platform-web/src/api/catalog.js`: catalog API client.
- Create `platform-web/src/modules/catalog/catalogForm.js`: form normalization and validation.
- Create `platform-web/src/modules/catalog/catalogForm.test.js`: dependency-free unit tests.
- Create `platform-web/src/views/Catalog/CatalogView.vue`: page orchestration and published/draft status.
- Create `platform-web/src/views/Catalog/components/ProductSkuPanel.vue`: product and SKU editing.
- Create `platform-web/src/views/Catalog/components/PriceRulePanel.vue`: price-rule editing.
- Create `platform-web/src/views/Catalog/components/FreightRulePanel.vue`: freight-rule editing.
- Create `platform-web/src/views/Catalog/components/ImportPreviewDialog.vue`: upload, warnings and commit confirmation.
- Create `platform-web/src/views/Catalog/components/QuoteTester.vue`: exact quote verification before AI integration.
- Modify `platform-web/src/router/index.js`: add `/catalog`.
- Modify `platform-web/src/components/Layout/AppSidebar.vue`: add “产品与报价”.
- Modify `platform-web/package.json`: add catalog unit-test script.

Version-control note: `E:\project\project\Rag` currently has no `.git` directory. Every task includes the required commit command, but execution must not run `git init` without user authorization. If Git remains unavailable, run all verification steps and report that the commit checkpoint was skipped because the project is not a repository.

### Task 1: Catalog validation contract

**Files:**
- Create: `rag-server/src/modules/catalog/catalog.constants.js`
- Create: `rag-server/src/modules/catalog/catalog.validation.js`
- Test: `rag-server/src/modules/catalog/catalog.validation.test.js`
- Modify: `rag-server/package.json`

- [ ] **Step 1: Add the failing validation tests**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePriceRule, normalizeFreightRule } = require('./catalog.validation')

test('normalizes a tiered USD price rule', () => {
  assert.deepEqual(normalizePriceRule({
    skuCode: 'COATING-500ML', customerType: 'retail', minQuantity: '1',
    maxQuantity: '', unit: 'kg', currency: 'usd', unitPrice: '200'
  }), {
    sku_code: 'COATING-500ML', customer_type: 'retail', min_quantity: 1,
    max_quantity: null, unit: 'kg', currency: 'USD', unit_price: 200
  })
})

test('rejects a non-positive price', () => {
  assert.throws(() => normalizePriceRule({
    skuCode: 'COATING-500ML', customerType: 'retail', minQuantity: 1,
    unit: 'kg', currency: 'USD', unitPrice: 0
  }), /unitPrice must be greater than 0/)
})

test('marks manual freight confirmation explicitly', () => {
  assert.equal(normalizeFreightRule({
    regionCode: 'BY', deliveryTerm: 'DDU', baseWeightKg: 0.5,
    currency: 'USD', manualConfirmation: true
  }).manualConfirmation, true)
})
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `cd rag-server && node --test src/modules/catalog/catalog.validation.test.js`

Expected: FAIL with `Cannot find module './catalog.validation'`.

- [ ] **Step 3: Implement constants and validation**

```js
// catalog.constants.js
module.exports = Object.freeze({
  VERSION_STATUS: { DRAFT: 'draft', PUBLISHED: 'published', RETIRED: 'retired' },
  ENTITY_STATUS: { ACTIVE: 'active', INACTIVE: 'inactive' },
  CUSTOMER_TYPES: new Set(['all', 'retail', 'wholesale']),
  DELIVERY_TERMS: new Set(['DDU', 'DDP', 'OTHER']),
  UNITS: new Set(['piece', 'ml', 'kg', 'sqm'])
})

// catalog.validation.js
const { CUSTOMER_TYPES, DELIVERY_TERMS, UNITS } = require('./catalog.constants')

function requiredText(value, field) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function positiveNumber(value, field, nullable = false) {
  if ((value === '' || value == null) && nullable) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be greater than 0`)
  return number
}

function normalizePriceRule(input) {
  const customerType = String(input.customerType || 'all').toLowerCase()
  const unit = String(input.unit || '').toLowerCase()
  if (!CUSTOMER_TYPES.has(customerType)) throw new Error('customerType is invalid')
  if (!UNITS.has(unit)) throw new Error('unit is invalid')
  return {
    id: input.id || undefined,
    sku_code: requiredText(input.skuCode || input.sku_code, 'skuCode').toUpperCase(),
    customer_type: customerType,
    min_quantity: positiveNumber(input.minQuantity ?? input.min_quantity, 'minQuantity'),
    max_quantity: positiveNumber(input.maxQuantity ?? input.max_quantity, 'maxQuantity', true),
    unit,
    currency: requiredText(input.currency, 'currency').toUpperCase(),
    unit_price: positiveNumber(input.unitPrice ?? input.unit_price, 'unitPrice'),
    effective_from: input.effectiveFrom || input.effective_from || null,
    effective_to: input.effectiveTo || input.effective_to || null,
    status: input.status || 'active'
  }
}

function normalizeFreightRule(input) {
  const deliveryTerm = String(input.deliveryTerm || input.delivery_term || 'OTHER').toUpperCase()
  if (!DELIVERY_TERMS.has(deliveryTerm)) throw new Error('deliveryTerm is invalid')
  return {
    id: input.id || undefined,
    region_code: requiredText(input.regionCode || input.region_code, 'regionCode').toUpperCase(),
    delivery_term: deliveryTerm,
    base_weight_kg: positiveNumber(input.baseWeightKg ?? input.base_weight_kg, 'baseWeightKg'),
    base_fee: positiveNumber(input.baseFee ?? input.base_fee, 'baseFee', true),
    incremental_weight_kg: positiveNumber(input.incrementalWeightKg ?? input.incremental_weight_kg, 'incrementalWeightKg', true),
    incremental_fee: positiveNumber(input.incrementalFee ?? input.incremental_fee, 'incrementalFee', true),
    currency: requiredText(input.currency, 'currency').toUpperCase(),
    manual_confirmation: input.manualConfirmation === true || input.manual_confirmation === true,
    effective_from: input.effectiveFrom || input.effective_from || null,
    effective_to: input.effectiveTo || input.effective_to || null,
    status: input.status || 'active'
  }
}

function normalizeProduct(input) {
  return { id: input.id || undefined, product_code: requiredText(input.productCode || input.product_code, 'productCode').toUpperCase(), name: requiredText(input.name, 'name'), description: String(input.description || '').trim() || null, status: input.status || 'active' }
}
function normalizeSku(input) {
  return { id: input.id || undefined, product_code: requiredText(input.productCode || input.product_code, 'productCode').toUpperCase(), sku_code: requiredText(input.skuCode || input.sku_code, 'skuCode').toUpperCase(), specification: input.specification || null, packaging: input.packaging || null, weight_kg: input.weightKg ?? input.weight_kg ?? null, coverage_min_sqm: input.coverageMinSqm ?? input.coverage_min_sqm ?? null, coverage_max_sqm: input.coverageMaxSqm ?? input.coverage_max_sqm ?? null, status: input.status || 'active' }
}

module.exports = { normalizeProduct, normalizeSku, normalizePriceRule, normalizeFreightRule }
```

Add to `rag-server/package.json` scripts:

```json
"test:catalog": "node --test src/modules/catalog/*.test.js"
```

- [ ] **Step 4: Run validation tests**

Run: `cd rag-server && npm run test:catalog`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit the validation contract**

```bash
git add rag-server/package.json rag-server/src/modules/catalog/catalog.constants.js rag-server/src/modules/catalog/catalog.validation.js rag-server/src/modules/catalog/catalog.validation.test.js
git commit -m "feat: define catalog validation contract"
```

### Task 2: Idempotent catalog schema

**Files:**
- Create: `rag-server/src/modules/catalog/catalog.schema.js`
- Test: `rag-server/src/modules/catalog/catalog.schema.test.js`
- Modify: `rag-server/src/config/database.js`

- [ ] **Step 1: Write a failing schema test using a fake Sequelize connection**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { ensureCatalogSchema } = require('./catalog.schema')

test('creates every catalog table with idempotent SQL', async () => {
  const statements = []
  await ensureCatalogSchema({ query: async sql => statements.push(sql.replace(/\s+/g, ' ').trim()) })
  for (const table of [
    'catalog_versions', 'catalog_products', 'catalog_skus', 'catalog_price_rules',
    'catalog_freight_rules', 'catalog_import_jobs', 'catalog_audit_logs', 'quote_records'
  ]) {
    assert.ok(statements.some(sql => sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`)), table)
  }
})
```

- [ ] **Step 2: Run the test and verify failure**

Run: `cd rag-server && node --test src/modules/catalog/catalog.schema.test.js`

Expected: FAIL with `Cannot find module './catalog.schema'`.

- [ ] **Step 3: Implement the schema initializer**

Create `ensureCatalogSchema(sequelize)` that sequentially executes `CREATE TABLE IF NOT EXISTS` statements with these exact keys:

```sql
CREATE TABLE IF NOT EXISTS catalog_versions (
  id VARCHAR(36) PRIMARY KEY,
  version_no VARCHAR(40) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  source_type VARCHAR(30) NULL,
  source_hash VARCHAR(64) NULL,
  created_by INT NULL,
  published_by INT NULL,
  published_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_catalog_version_status (status, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_products (
  id VARCHAR(36) PRIMARY KEY,
  version_id VARCHAR(36) NOT NULL,
  product_code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_catalog_product_version_code (version_id, product_code),
  INDEX idx_catalog_product_version (version_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_skus (
  id VARCHAR(36) PRIMARY KEY,
  version_id VARCHAR(36) NOT NULL,
  product_code VARCHAR(80) NOT NULL,
  sku_code VARCHAR(100) NOT NULL,
  specification VARCHAR(255) NULL,
  packaging VARCHAR(255) NULL,
  weight_kg DECIMAL(12,3) NULL,
  coverage_min_sqm DECIMAL(12,2) NULL,
  coverage_max_sqm DECIMAL(12,2) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_catalog_sku_version_code (version_id, sku_code),
  INDEX idx_catalog_sku_product (version_id, product_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Append these complete statements to the schema initializer:

```sql
CREATE TABLE IF NOT EXISTS catalog_price_rules (
  id VARCHAR(36) PRIMARY KEY,
  version_id VARCHAR(36) NOT NULL,
  sku_code VARCHAR(100) NOT NULL,
  customer_type VARCHAR(20) NOT NULL DEFAULT 'all',
  min_quantity DECIMAL(12,3) NOT NULL,
  max_quantity DECIMAL(12,3) NULL,
  unit VARCHAR(20) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  effective_from DATETIME NULL,
  effective_to DATETIME NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_catalog_price_lookup (version_id, sku_code, currency, min_quantity),
  INDEX idx_catalog_price_effective (version_id, status, effective_from, effective_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_freight_rules (
  id VARCHAR(36) PRIMARY KEY,
  version_id VARCHAR(36) NOT NULL,
  region_code VARCHAR(30) NOT NULL,
  delivery_term VARCHAR(20) NOT NULL DEFAULT 'OTHER',
  base_weight_kg DECIMAL(12,3) NOT NULL,
  base_fee DECIMAL(12,2) NULL,
  incremental_weight_kg DECIMAL(12,3) NULL,
  incremental_fee DECIMAL(12,2) NULL,
  currency VARCHAR(10) NOT NULL,
  manual_confirmation TINYINT(1) NOT NULL DEFAULT 0,
  effective_from DATETIME NULL,
  effective_to DATETIME NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_catalog_freight_lookup (version_id, region_code, delivery_term),
  INDEX idx_catalog_freight_effective (version_id, status, effective_from, effective_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_import_jobs (
  id VARCHAR(36) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  source_hash VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  preview_json JSON NOT NULL,
  committed_version_id VARCHAR(36) NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_catalog_import_hash (source_hash, status),
  INDEX idx_catalog_import_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  action VARCHAR(40) NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  operator_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_catalog_audit_entity (entity_type, entity_id, created_at),
  INDEX idx_catalog_audit_operator (operator_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quote_records (
  id VARCHAR(36) PRIMARY KEY,
  customer_id VARCHAR(36) NULL,
  conversation_id VARCHAR(36) NULL,
  channel VARCHAR(30) NULL,
  account_id INT NULL,
  sku_code VARCHAR(100) NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  customer_type VARCHAR(20) NOT NULL,
  region_code VARCHAR(30) NULL,
  delivery_term VARCHAR(20) NULL,
  version_id VARCHAR(36) NULL,
  price_rule_id VARCHAR(36) NULL,
  freight_rule_id VARCHAR(36) NULL,
  result_json JSON NOT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_quote_customer (customer_id, created_at),
  INDEX idx_quote_conversation (conversation_id, created_at),
  INDEX idx_quote_version (version_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: Wire schema creation into database startup**

At the top of `database.js` add:

```js
const { ensureCatalogSchema } = require('../modules/catalog/catalog.schema')
```

Immediately after `await sequelize.sync({ force: false })` add:

```js
await ensureCatalogSchema(sequelize)
console.log('catalog tables ready')
```

- [ ] **Step 5: Run schema and existing regression tests**

Run: `cd rag-server && npm run test:catalog && node --test src/modules/messaging/inboundMessage.service.test.js src/modules/cloud-gateway/cloudGateway.test.js`

Expected: catalog schema test PASS; all existing messaging and gateway tests PASS.

- [ ] **Step 6: Commit the schema**

```bash
git add rag-server/src/config/database.js rag-server/src/modules/catalog/catalog.schema.js rag-server/src/modules/catalog/catalog.schema.test.js
git commit -m "feat: add versioned catalog schema"
```

### Task 3: Draft lifecycle, CRUD and publication

**Files:**
- Create: `rag-server/src/modules/catalog/catalog.repository.js`
- Create: `rag-server/src/modules/catalog/catalog.service.js`
- Test: `rag-server/src/modules/catalog/catalog.service.test.js`

- [ ] **Step 1: Write failing service tests with an in-memory fake repository**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createCatalogService } = require('./catalog.service')

test('publishing a draft retires the old version atomically', async () => {
  const calls = []
  const repository = {
    transaction: async fn => fn({ id: 'tx' }),
    getVersion: async id => ({ id, status: 'draft' }),
    retirePublished: async tx => calls.push(['retire', tx.id]),
    publishVersion: async (id, userId, tx) => calls.push(['publish', id, userId, tx.id]),
    writeAudit: async row => calls.push(['audit', row.action])
  }
  await createCatalogService({ repository, now: () => new Date('2026-07-24T00:00:00Z') })
    .publishVersion('draft-1', 9)
  assert.deepEqual(calls.map(row => row[0]), ['retire', 'publish', 'audit'])
})

test('published versions cannot be edited', async () => {
  const service = createCatalogService({
    repository: { getVersion: async () => ({ id: 'v1', status: 'published' }) }
  })
  await assert.rejects(() => service.upsertProduct('v1', {}, 9), /draft version/)
})
```

- [ ] **Step 2: Run the service test and verify failure**

Run: `cd rag-server && node --test src/modules/catalog/catalog.service.test.js`

Expected: FAIL with missing `catalog.service`.

- [ ] **Step 3: Implement repository methods**

Implement parameterized SQL only. Use this whitelist-driven helper so product, SKU, price and freight writes share one safe path:

```js
const crypto = require('crypto')

const ENTITY = {
  product: { table: 'catalog_products', key: 'product_code', columns: ['product_code', 'name', 'description', 'status'] },
  sku: { table: 'catalog_skus', key: 'sku_code', columns: ['product_code', 'sku_code', 'specification', 'packaging', 'weight_kg', 'coverage_min_sqm', 'coverage_max_sqm', 'status'] },
  price: { table: 'catalog_price_rules', key: 'id', columns: ['sku_code', 'customer_type', 'min_quantity', 'max_quantity', 'unit', 'currency', 'unit_price', 'effective_from', 'effective_to', 'status'] },
  freight: { table: 'catalog_freight_rules', key: 'id', columns: ['region_code', 'delivery_term', 'base_weight_kg', 'base_fee', 'incremental_weight_kg', 'incremental_fee', 'currency', 'manual_confirmation', 'effective_from', 'effective_to', 'status'] }
}

function createRepository(sequelize) {
  async function upsertVersioned(kind, versionId, input, transaction) {
    const config = ENTITY[kind]
    if (!config) throw new Error('unsupported catalog entity')
    const id = input.id || crypto.randomUUID()
    const values = Object.fromEntries(config.columns.map(column => [column, input[column] ?? null]))
    const columns = ['id', 'version_id', ...config.columns]
    const updates = config.columns.filter(column => column !== config.key).map(column => `${column}=VALUES(${column})`)
    await sequelize.query(
      `INSERT INTO ${config.table} (${columns.join(',')}) VALUES (${columns.map(column => `:${column}`).join(',')}) ON DUPLICATE KEY UPDATE ${updates.join(',')}`,
      { replacements: { id, version_id: versionId, ...values }, transaction }
    )
    return { id, version_id: versionId, ...values }
  }

  async function listVersioned(kind, versionId) {
    const config = ENTITY[kind]
    if (!config) throw new Error('unsupported catalog entity')
    const [rows] = await sequelize.query(
      `SELECT * FROM ${config.table} WHERE version_id=:versionId ORDER BY created_at ASC`,
      { replacements: { versionId } }
    )
    return rows
  }

  return {
    transaction: fn => sequelize.transaction(fn),
    async listVersions() { const [rows] = await sequelize.query('SELECT * FROM catalog_versions ORDER BY created_at DESC'); return rows },
    async getVersion(id, transaction) { const [rows] = await sequelize.query('SELECT * FROM catalog_versions WHERE id=:id LIMIT 1', { replacements: { id }, transaction }); return rows[0] || null },
    async createDraftFromPublished(userId, now) {
      return sequelize.transaction(async transaction => {
        const id = crypto.randomUUID()
        const versionNo = `CAT-${now.toISOString().replace(/\D/g, '').slice(0, 14)}`
        await sequelize.query('INSERT INTO catalog_versions (id,version_no,status,created_by) VALUES (:id,:versionNo,\'draft\',:userId)', { replacements: { id, versionNo, userId }, transaction })
        for (const table of ['catalog_products', 'catalog_skus', 'catalog_price_rules', 'catalog_freight_rules']) {
          const [published] = await sequelize.query('SELECT id FROM catalog_versions WHERE status=\'published\' ORDER BY published_at DESC LIMIT 1', { transaction })
          if (published[0]) await sequelize.query(`INSERT INTO ${table} SELECT UUID(), :id, ${table === 'catalog_products' ? 'product_code,name,description,status,created_at,updated_at' : table === 'catalog_skus' ? 'product_code,sku_code,specification,packaging,weight_kg,coverage_min_sqm,coverage_max_sqm,status,created_at,updated_at' : table === 'catalog_price_rules' ? 'sku_code,customer_type,min_quantity,max_quantity,unit,currency,unit_price,effective_from,effective_to,status,created_at,updated_at' : 'region_code,delivery_term,base_weight_kg,base_fee,incremental_weight_kg,incremental_fee,currency,manual_confirmation,effective_from,effective_to,status,created_at,updated_at'} FROM ${table} WHERE version_id=:publishedId`, { replacements: { id, publishedId: published[0].id }, transaction })
        }
        return { id, version_no: versionNo, status: 'draft' }
      })
    },
    retirePublished: transaction => sequelize.query("UPDATE catalog_versions SET status='retired',updated_at=NOW() WHERE status='published'", { transaction }),
    publishVersion: (id, userId, transaction) => sequelize.query("UPDATE catalog_versions SET status='published',published_by=:userId,published_at=NOW(),updated_at=NOW() WHERE id=:id AND status='draft'", { replacements: { id, userId }, transaction }),
    listProducts: versionId => listVersioned('product', versionId),
    listSkus: versionId => listVersioned('sku', versionId),
    listPriceRules: versionId => listVersioned('price', versionId),
    listFreightRules: versionId => listVersioned('freight', versionId),
    upsertProduct: (versionId, input, transaction) => upsertVersioned('product', versionId, input, transaction),
    upsertSku: (versionId, input, transaction) => upsertVersioned('sku', versionId, input, transaction),
    upsertPriceRule: (versionId, input, transaction) => upsertVersioned('price', versionId, input, transaction),
    upsertFreightRule: (versionId, input, transaction) => upsertVersioned('freight', versionId, input, transaction),
    deleteVersioned: (kind, versionId, id) => { const config = ENTITY[kind]; return sequelize.query(`DELETE FROM ${config.table} WHERE version_id=:versionId AND id=:id`, { replacements: { versionId, id } }) },
    async findCommittedImportByHash(sourceHash) { const [rows] = await sequelize.query("SELECT id,committed_version_id FROM catalog_import_jobs WHERE source_hash=:sourceHash AND status='committed' LIMIT 1", { replacements: { sourceHash } }); return rows[0] || null },
    async createImportJob(row) { const id = crypto.randomUUID(); await sequelize.query('INSERT INTO catalog_import_jobs (id,filename,source_hash,status,preview_json,created_by) VALUES (:id,:filename,:sourceHash,:status,:previewJson,:createdBy)', { replacements: { ...row, id, previewJson: JSON.stringify(row.previewJson) } }); return { id, ...row } },
    async getImportJob(id) { const [rows] = await sequelize.query('SELECT * FROM catalog_import_jobs WHERE id=:id LIMIT 1', { replacements: { id } }); const row = rows[0]; if (row && typeof row.preview_json === 'string') row.preview_json = JSON.parse(row.preview_json); return row || null },
    markImportCommitted: (id, versionId) => sequelize.query("UPDATE catalog_import_jobs SET status='committed',committed_version_id=:versionId,updated_at=NOW() WHERE id=:id AND status='previewed'", { replacements: { id, versionId } }),
    async loadPublishedCatalog(now) { const [versions] = await sequelize.query("SELECT * FROM catalog_versions WHERE status='published' ORDER BY published_at DESC LIMIT 1"); if (!versions[0]) return null; const versionId = versions[0].id; const [priceRules] = await sequelize.query("SELECT * FROM catalog_price_rules WHERE version_id=:versionId AND status='active' AND (effective_from IS NULL OR effective_from<=:now) AND (effective_to IS NULL OR effective_to>:now)", { replacements: { versionId, now } }); const [freightRules] = await sequelize.query("SELECT * FROM catalog_freight_rules WHERE version_id=:versionId AND status='active' AND (effective_from IS NULL OR effective_from<=:now) AND (effective_to IS NULL OR effective_to>:now)", { replacements: { versionId, now } }); return { versionId, priceRules, freightRules } },
    async createQuoteRecord(row) { const id = crypto.randomUUID(); await sequelize.query('INSERT INTO quote_records (id,customer_id,conversation_id,channel,account_id,sku_code,quantity,customer_type,region_code,delivery_term,version_id,price_rule_id,freight_rule_id,result_json,created_by) VALUES (:id,:customerId,:conversationId,:channel,:accountId,:skuCode,:quantity,:customerType,:regionCode,:deliveryTerm,:versionId,:priceRuleId,:freightRuleId,:resultJson,:createdBy)', { replacements: { id, customerId: row.customerId || null, conversationId: row.conversationId || null, channel: row.channel || null, accountId: row.accountId || null, skuCode: row.skuCode, quantity: row.quantity, customerType: row.customerType, regionCode: row.regionCode || null, deliveryTerm: row.deliveryTerm || null, versionId: row.result.versionId || null, priceRuleId: row.result.priceRuleId || null, freightRuleId: row.result.freightRuleId || null, resultJson: JSON.stringify(row.result), createdBy: row.createdBy || null } }); return { id, ...row.result } },
    async writeAudit(row) { await sequelize.query('INSERT INTO catalog_audit_logs (id,entity_type,entity_id,action,before_json,after_json,operator_id) VALUES (UUID(),:entityType,:entityId,:action,:beforeJson,:afterJson,:operatorId)', { replacements: { ...row, beforeJson: row.beforeJson ? JSON.stringify(row.beforeJson) : null, afterJson: row.afterJson ? JSON.stringify(row.afterJson) : null }, transaction: row.transaction }) }
  }
}

module.exports = { createRepository }
```

- [ ] **Step 4: Implement service rules**

```js
function createCatalogService({ repository, now = () => new Date() }) {
  async function requireDraft(versionId) {
    const version = await repository.getVersion(versionId)
    if (!version || version.status !== 'draft') throw new Error('catalog changes require a draft version')
    return version
  }

  return {
    listVersions: () => repository.listVersions(),
    createDraft: userId => repository.createDraftFromPublished(userId, now()),
    async upsertProduct(versionId, input, userId) {
      await requireDraft(versionId)
      const result = await repository.upsertProduct(versionId, input)
      await repository.writeAudit({ entityType: 'product', entityId: result.id, action: 'upsert', afterJson: input, operatorId: userId })
      return result
    },
    async publishVersion(versionId, userId) {
      await requireDraft(versionId)
      return repository.transaction(async transaction => {
        await repository.retirePublished(transaction)
        await repository.publishVersion(versionId, userId, transaction)
        await repository.writeAudit({ entityType: 'catalog_version', entityId: versionId, action: 'publish', operatorId: userId, transaction })
        return repository.getVersion(versionId, transaction)
      })
    }
  }
}

module.exports = { createCatalogService }
```

Replace the returned service object in the previous snippet with this complete object and keep `writeDraft` inside `createCatalogService`:

```js
async function writeDraft(kind, versionId, input, userId) {
  await requireDraft(versionId)
  const normalizers = { product: normalizeProduct, sku: normalizeSku, price: normalizePriceRule, freight: normalizeFreightRule }
  const normalized = normalizers[kind](input)
  const method = { product: 'upsertProduct', sku: 'upsertSku', price: 'upsertPriceRule', freight: 'upsertFreightRule' }[kind]
  const result = await repository[method](versionId, normalized)
  await repository.writeAudit({ entityType: kind, entityId: result.id, action: 'upsert', afterJson: normalized, operatorId: userId })
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
  },
  async publishVersion(versionId, userId) {
    await requireDraft(versionId)
    return repository.transaction(async transaction => {
      await repository.retirePublished(transaction)
      await repository.publishVersion(versionId, userId, transaction)
      await repository.writeAudit({ entityType: 'catalog_version', entityId: versionId, action: 'publish', operatorId: userId, transaction })
      return repository.getVersion(versionId, transaction)
    })
  }
}
```

- [ ] **Step 5: Run all catalog service tests**

Run: `cd rag-server && npm run test:catalog`

Expected: all Task 1-3 tests PASS.

- [ ] **Step 6: Commit the lifecycle implementation**

```bash
git add rag-server/src/modules/catalog/catalog.repository.js rag-server/src/modules/catalog/catalog.service.js rag-server/src/modules/catalog/catalog.service.test.js
git commit -m "feat: add catalog draft and publish lifecycle"
```

### Task 4: Exact quote resolver

**Files:**
- Create: `rag-server/src/modules/catalog/quote.service.js`
- Test: `rag-server/src/modules/catalog/quote.service.test.js`

- [ ] **Step 1: Write failing quote-selection tests**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveQuote } = require('./quote.service')

const priceRules = [
  { id: 'r1', sku_code: 'COATING-1KG', customer_type: 'retail', min_quantity: 1, max_quantity: 9, currency: 'USD', unit_price: 200 },
  { id: 'r2', sku_code: 'COATING-1KG', customer_type: 'wholesale', min_quantity: 10, max_quantity: 49, currency: 'USD', unit_price: 160 },
  { id: 'r3', sku_code: 'COATING-1KG', customer_type: 'wholesale', min_quantity: 50, max_quantity: null, currency: 'USD', unit_price: 140 }
]

test('selects the most specific quantity tier', () => {
  const result = resolveQuote({ skuCode: 'COATING-1KG', quantity: 50, currency: 'USD', customerType: 'wholesale' }, { versionId: 'v1', priceRules, freightRules: [] })
  assert.equal(result.priceRuleId, 'r3')
  assert.equal(result.goodsAmount, 7000)
})

test('never invents a price when no rule matches', () => {
  const result = resolveQuote({ skuCode: 'UNKNOWN', quantity: 1, currency: 'USD', customerType: 'retail' }, { versionId: 'v1', priceRules, freightRules: [] })
  assert.deepEqual(result, { status: 'manual_confirmation', reason: 'no_active_price_rule' })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd rag-server && node --test src/modules/catalog/quote.service.test.js`

Expected: FAIL with missing `quote.service`.

- [ ] **Step 3: Implement deterministic quote selection**

```js
function resolveQuote(input, catalog) {
  const quantity = Number(input.quantity)
  const matching = catalog.priceRules
    .filter(rule => rule.sku_code === input.skuCode)
    .filter(rule => rule.currency === input.currency)
    .filter(rule => rule.customer_type === input.customerType || rule.customer_type === 'all')
    .filter(rule => quantity >= Number(rule.min_quantity) && (rule.max_quantity == null || quantity <= Number(rule.max_quantity)))
    .sort((a, b) => Number(b.min_quantity) - Number(a.min_quantity))
  const price = matching[0]
  if (!price) return { status: 'manual_confirmation', reason: 'no_active_price_rule' }

  const freight = selectFreight(input, catalog.freightRules)
  if (freight?.manual_confirmation) return { status: 'manual_confirmation', reason: 'freight_requires_confirmation', priceRuleId: price.id }
  const goodsAmount = Number((quantity * Number(price.unit_price)).toFixed(2))
  const freightAmount = freight ? calculateFreight(input.weightKg, freight) : null
  return {
    status: freightAmount == null && input.regionCode ? 'manual_confirmation' : 'quoted',
    versionId: catalog.versionId,
    priceRuleId: price.id,
    freightRuleId: freight?.id || null,
    currency: price.currency,
    unitPrice: Number(price.unit_price),
    quantity,
    goodsAmount,
    freightAmount,
    totalAmount: freightAmount == null ? null : Number((goodsAmount + freightAmount).toFixed(2))
  }
}
```

Add these exact helpers above `resolveQuote`:

```js
function selectFreight(input, rules) {
  if (!input.regionCode) return null
  return rules
    .filter(rule => rule.currency === input.currency)
    .filter(rule => rule.delivery_term === (input.deliveryTerm || 'OTHER'))
    .filter(rule => rule.region_code === input.regionCode || rule.region_code === 'DEFAULT')
    .sort((a, b) => Number(b.region_code === input.regionCode) - Number(a.region_code === input.regionCode))[0] || null
}

function calculateFreight(weightKg, rule) {
  if (rule.base_fee == null || !Number.isFinite(Number(weightKg))) return null
  const extraWeight = Math.max(0, Number(weightKg) - Number(rule.base_weight_kg))
  const stepWeight = Number(rule.incremental_weight_kg || 0)
  if (extraWeight > 0 && stepWeight <= 0) return null
  const steps = extraWeight === 0 ? 0 : Math.ceil(extraWeight / stepWeight)
  return Number((Number(rule.base_fee) + steps * Number(rule.incremental_fee || 0)).toFixed(2))
}

function createQuoteService({ repository, now = () => new Date() }) {
  return {
    async resolveAndRecord(input, userId) {
      const catalog = await repository.loadPublishedCatalog(now())
      const result = catalog ? resolveQuote(input, catalog) : { status: 'manual_confirmation', reason: 'no_published_catalog' }
      await repository.createQuoteRecord({ ...input, result, createdBy: userId })
      return result
    }
  }
}

module.exports = { resolveQuote, createQuoteService }
```

- [ ] **Step 4: Add boundary tests and run**

Add tests for quantities 9/10/49/50, an expired rule filtered by the repository, DDP versus DDU, missing country, and manual freight. Run `npm run test:catalog` and expect all tests PASS.

- [ ] **Step 5: Commit quote resolution**

```bash
git add rag-server/src/modules/catalog/quote.service.js rag-server/src/modules/catalog/quote.service.test.js
git commit -m "feat: resolve exact versioned quotes"
```

### Task 5: File import preview and commit

**Files:**
- Create: `rag-server/src/modules/catalog/catalog.import.service.js`
- Test: `rag-server/src/modules/catalog/catalog.import.service.test.js`

- [ ] **Step 1: Write failing tests using the existing price Markdown shape**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseCatalogBuffer } = require('./catalog.import.service')

test('extracts retail and wholesale price rows from Markdown', () => {
  const markdown = Buffer.from(`# 价格与运费\n\n### 零售价格\n| 规格 | 重量 | 美元价 |\n|---|---|---|\n| 500ml | 0.5kg | $100 |\n\n### 批发价格\n| 规格 | 美元价 |\n|---|---|\n| 10kg+ | $160/kg |`, 'utf8')
  const preview = parseCatalogBuffer({ filename: 'price.md', buffer: markdown })
  assert.equal(preview.priceRules.length, 2)
  assert.equal(preview.priceRules[0].unitPrice, 100)
  assert.equal(preview.priceRules[1].minQuantity, 10)
})

test('does not treat the marketing-keyword workbook as a price catalog', () => {
  const preview = parseCatalogBuffer({ filename: 'keywords.xlsx', buffer: Buffer.from('invalid workbook') })
  assert.equal(preview.accepted, false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd rag-server && node --test src/modules/catalog/catalog.import.service.test.js`

Expected: FAIL with missing `catalog.import.service`.

- [ ] **Step 3: Implement safe Markdown and Excel parsing**

Use `crypto.createHash('sha256')` for source identity. Implement the parser with this concrete boundary; helper `rowsFromMarkdownTables` returns `{ heading, headers, rows }` for pipe tables immediately following Markdown headings:

```js
const crypto = require('crypto')
const path = require('path')
const XLSX = require('xlsx')

function money(value) {
  const match = String(value || '').replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

function rowsFromMarkdownTables(text) {
  const lines = text.split(/\r?\n/)
  const tables = []
  let heading = ''
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,4}\s+/.test(lines[i])) heading = lines[i].replace(/^#{1,4}\s+/, '').trim()
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[-:\s|]+\|?\s*$/.test(lines[i + 1] || '')) continue
    const split = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
    const headers = split(lines[i])
    const rows = []
    i += 2
    while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(Object.fromEntries(headers.map((header, index) => [header, split(lines[i])[index] || '']))); i += 1 }
    tables.push({ heading, headers, rows })
    i -= 1
  }
  return tables
}

function parseMarkdown(text) {
  const result = { products: [], skus: [], priceRules: [], freightRules: [], warnings: [] }
  const productCodes = new Set(), skuCodes = new Set()
  for (const table of rowsFromMarkdownTables(text)) {
    if (/零售价格|批发价格/.test(table.heading)) {
      const wholesale = /批发/.test(table.heading)
      for (const row of table.rows) {
        const spec = row['规格'] || row['重量']
        const unitPrice = money(row['美元价'])
        if (!spec || !unitPrice) { result.warnings.push(`跳过无法识别的价格行: ${JSON.stringify(row)}`); continue }
        const quantityMatch = spec.match(/(\d+(?:\.\d+)?)\s*kg\+?/i)
        const minQuantity = quantityMatch ? Number(quantityMatch[1]) : 1
        const skuCode = `COATING-${spec.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toUpperCase()}`
        if (!productCodes.has('GLASS-COATING')) { result.products.push({ productCode: 'GLASS-COATING', name: '纳米陶瓷玻璃隔热镀膜涂层', description: '由价格资料导入', status: 'active' }); productCodes.add('GLASS-COATING') }
        if (!skuCodes.has(skuCode)) { result.skus.push({ productCode: 'GLASS-COATING', skuCode, specification: spec, packaging: spec, status: 'active' }); skuCodes.add(skuCode) }
        result.priceRules.push({ skuCode, customerType: wholesale ? 'wholesale' : 'retail', minQuantity, maxQuantity: null, unit: /ml/i.test(spec) ? 'ml' : 'kg', currency: 'USD', unitPrice })
      }
    }
    if (/通用运费规则|具体国家运费速查/.test(table.heading)) {
      for (const row of table.rows) {
        const regionCode = row['国家'] || row['区域']
        const baseFee = money(row['运费'] || row['基础运费'])
        result.freightRules.push({ regionCode, deliveryTerm: 'OTHER', baseWeightKg: 0.5, baseFee, incrementalWeightKg: 0.5, incrementalFee: money(row['每增加500g']), currency: 'USD', manualConfirmation: baseFee == null })
      }
    }
  }
  return result
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false })
  const allowed = new Set(['Products', 'SKUs', 'Prices', 'Freight'])
  const recognized = workbook.SheetNames.filter(name => allowed.has(name))
  if (!recognized.length) return { accepted: false, products: [], skus: [], priceRules: [], freightRules: [], warnings: ['未找到 Products、SKUs、Prices 或 Freight 工作表'] }
  const rows = name => workbook.Sheets[name] ? XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null, raw: true }) : []
  return { accepted: true, products: rows('Products'), skus: rows('SKUs'), priceRules: rows('Prices'), freightRules: rows('Freight'), warnings: [] }
}

function parseCatalogBuffer({ filename, buffer }) {
  const sourceHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = path.extname(filename).toLowerCase()
  let parsed
  try {
    parsed = extension === '.md' ? { accepted: true, ...parseMarkdown(buffer.toString('utf8')) }
      : ['.xlsx', '.xls'].includes(extension) ? parseWorkbook(buffer)
        : { accepted: false, products: [], skus: [], priceRules: [], freightRules: [], warnings: ['不支持的文件类型'] }
  } catch (error) {
    parsed = { accepted: false, products: [], skus: [], priceRules: [], freightRules: [], warnings: [`文件解析失败: ${error.message}`] }
  }
  return { sourceHash, ...parsed }
}
```

Never evaluate formulas or macros. Excel accepts only the four named sheets; any other workbook returns `accepted:false` plus a warning and no candidate rows.

Export:

```js
module.exports = {
  parseCatalogBuffer,
  createImportService({ repository, catalogService }) {
    return {
      async preview(file, userId) {
        const parsed = parseCatalogBuffer({ filename: file.originalname, buffer: file.buffer })
        const committed = await repository.findCommittedImportByHash(parsed.sourceHash)
        if (committed) return repository.createImportJob({ filename: file.originalname, sourceHash: parsed.sourceHash, status: 'duplicate', previewJson: { ...parsed, accepted: false, warnings: [...parsed.warnings, `相同文件已导入版本 ${committed.committed_version_id}`] }, createdBy: userId })
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
}
```

- [ ] **Step 4: Test the actual project price file read-only**

Run a Node one-liner that reads `rag-server/src/private/knowledge-sources/3a1953c4-166f-4c66-8a5c-7f1de3d433e2.md`, calls `parseCatalogBuffer`, and prints counts only.

Expected: accepted preview, retail and wholesale price candidates, freight candidates, no database writes.

- [ ] **Step 5: Commit import preview**

```bash
git add rag-server/src/modules/catalog/catalog.import.service.js rag-server/src/modules/catalog/catalog.import.service.test.js
git commit -m "feat: preview catalog imports safely"
```

### Task 6: Authenticated catalog REST API

**Files:**
- Create: `rag-server/src/modules/catalog/catalog.routes.js`
- Test: `rag-server/src/modules/catalog/catalog.routes.test.js`
- Modify: `rag-server/src/app.js`

- [ ] **Step 1: Test the route policy as a pure dependency-injected contract**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { canManageCatalog, canReadCatalog } = require('./catalog.routes')

test('agents can read but cannot publish catalog versions', () => {
  assert.equal(canReadCatalog({ role: 'agent' }), true)
  assert.equal(canManageCatalog({ role: 'agent' }), false)
})

test('supervisors and admins can manage catalog versions', () => {
  assert.equal(canManageCatalog({ role: 'supervisor' }), true)
  assert.equal(canManageCatalog({ role: 'admin' }), true)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd rag-server && node --test src/modules/catalog/catalog.routes.test.js`

Expected: FAIL with missing `catalog.routes`.

- [ ] **Step 3: Implement endpoints and role checks**

Implement the route factory and role policy first:

```js
const express = require('express')
const jwt = require('jsonwebtoken')
const multer = require('multer')

const canReadCatalog = user => ['agent', 'supervisor', 'admin'].includes(user?.role)
const canManageCatalog = user => ['supervisor', 'admin'].includes(user?.role)
const requirePermission = predicate => (req, res, next) => predicate(req.user) ? next() : res.status(403).json({ success: false, message: '无权执行此操作' })
const respond = handler => async (req, res) => {
  try { res.json({ success: true, data: await handler(req) }) }
  catch (error) {
    const message = error.message || '请求失败'
    const status = /required|invalid|must be|不支持/.test(message) ? 400 : /draft version|not ready/.test(message) ? 409 : /not found|不存在/.test(message) ? 404 : 500
    res.status(status).json({ success: false, message })
  }
}

function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!process.env.JWT_SECRET) return res.status(500).json({ success: false, message: 'JWT_SECRET 未配置' })
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch { res.status(401).json({ success: false, message: '认证失败' }) }
}

function createCatalogRouter({ catalogService, importService, quoteService }) {
  const router = express.Router()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
  router.use(authenticate, requirePermission(canReadCatalog))
  router.get('/versions', respond(() => catalogService.listVersions()))
  router.post('/versions/draft', requirePermission(canManageCatalog), respond(req => catalogService.createDraft(req.user.id)))
  router.post('/versions/:id/publish', requirePermission(canManageCatalog), respond(req => catalogService.publishVersion(req.params.id, req.user.id)))
  router.get('/versions/:id/products', respond(req => catalogService.listProducts(req.params.id)))
  router.post('/versions/:id/products', requirePermission(canManageCatalog), respond(req => catalogService.upsertProduct(req.params.id, req.body, req.user.id)))
  router.get('/versions/:id/skus', respond(req => catalogService.listSkus(req.params.id)))
  router.post('/versions/:id/skus', requirePermission(canManageCatalog), respond(req => catalogService.upsertSku(req.params.id, req.body, req.user.id)))
  router.get('/versions/:id/prices', respond(req => catalogService.listPriceRules(req.params.id)))
  router.post('/versions/:id/prices', requirePermission(canManageCatalog), respond(req => catalogService.upsertPriceRule(req.params.id, req.body, req.user.id)))
  router.get('/versions/:id/freight', respond(req => catalogService.listFreightRules(req.params.id)))
  router.post('/versions/:id/freight', requirePermission(canManageCatalog), respond(req => catalogService.upsertFreightRule(req.params.id, req.body, req.user.id)))
  router.post('/import/preview', requirePermission(canManageCatalog), upload.single('file'), respond(req => importService.preview(req.file, req.user.id)))
  router.post('/import/:jobId/commit', requirePermission(canManageCatalog), respond(req => importService.commit(req.params.jobId, req.user.id)))
  router.post('/quote/resolve', respond(req => quoteService.resolveAndRecord(req.body, req.user.id)))
  return router
}

const { sequelize } = require('../../config/database')
const { createRepository } = require('./catalog.repository')
const { createCatalogService } = require('./catalog.service')
const { createImportService } = require('./catalog.import.service')
const { createQuoteService } = require('./quote.service')
const repository = createRepository(sequelize)
const catalogService = createCatalogService({ repository })
const router = createCatalogRouter({
  catalogService,
  importService: createImportService({ repository, catalogService }),
  quoteService: createQuoteService({ repository })
})
module.exports = router
module.exports.createCatalogRouter = createCatalogRouter
module.exports.canReadCatalog = canReadCatalog
module.exports.canManageCatalog = canManageCatalog
```

Add these update handlers before returning the router:

```js
router.put('/versions/:id/products/:productCode', requirePermission(canManageCatalog), respond(req => catalogService.upsertProduct(req.params.id, { ...req.body, productCode: req.params.productCode }, req.user.id)))
router.put('/versions/:id/skus/:skuCode', requirePermission(canManageCatalog), respond(req => catalogService.upsertSku(req.params.id, { ...req.body, skuCode: req.params.skuCode }, req.user.id)))
router.put('/versions/:id/prices/:ruleId', requirePermission(canManageCatalog), respond(req => catalogService.upsertPriceRule(req.params.id, { ...req.body, id: req.params.ruleId }, req.user.id)))
router.put('/versions/:id/freight/:ruleId', requirePermission(canManageCatalog), respond(req => catalogService.upsertFreightRule(req.params.id, { ...req.body, id: req.params.ruleId }, req.user.id)))
```

Mount these endpoints:

```text
GET    /versions
POST   /versions/draft
POST   /versions/:id/publish
GET    /versions/:id/products
POST   /versions/:id/products
PUT    /versions/:id/products/:productCode
GET    /versions/:id/skus
POST   /versions/:id/skus
PUT    /versions/:id/skus/:skuCode
GET    /versions/:id/prices
POST   /versions/:id/prices
PUT    /versions/:id/prices/:ruleId
GET    /versions/:id/freight
POST   /versions/:id/freight
PUT    /versions/:id/freight/:ruleId
POST   /import/preview
POST   /import/:jobId/commit
POST   /quote/resolve
```

Use `multer.memoryStorage()` with 10 MB size limit and extensions `.md`, `.xlsx`, `.xls`. JWT authentication follows existing route behavior. Read and quote endpoints allow `agent`, `supervisor`, `admin`; all mutations require `supervisor` or `admin`. Return `{ success: true, data }`; validation errors return 400, authorization 403, missing records 404, conflicts 409.

- [ ] **Step 4: Register the router**

In `app.js`:

```js
const catalogRoutes = require('./modules/catalog/catalog.routes')
// after customer routes
app.use('/api/v1/catalog', catalogRoutes)
```

- [ ] **Step 5: Run catalog and existing route-adjacent tests**

Run: `cd rag-server && npm run test:catalog && node --test src/modules/messaging/inboundMessage.service.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit the REST API**

```bash
git add rag-server/src/app.js rag-server/src/modules/catalog/catalog.routes.js rag-server/src/modules/catalog/catalog.routes.test.js
git commit -m "feat: expose catalog management api"
```

### Task 7: Frontend catalog API and form contract

**Files:**
- Create: `platform-web/src/api/catalog.js`
- Create: `platform-web/src/modules/catalog/catalogForm.js`
- Test: `platform-web/src/modules/catalog/catalogForm.test.js`
- Modify: `platform-web/package.json`

- [ ] **Step 1: Write failing form tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePriceForm, validatePriceForm } from './catalogForm.js'

test('normalizes numeric form fields before API submission', () => {
  assert.deepEqual(normalizePriceForm({ skuCode: 'coat-1kg', minQuantity: '10', maxQuantity: '', unitPrice: '160', currency: 'usd', unit: 'kg', customerType: 'wholesale' }), {
    skuCode: 'COAT-1KG', minQuantity: 10, maxQuantity: null, unitPrice: 160, currency: 'USD', unit: 'kg', customerType: 'wholesale'
  })
})

test('requires a positive unit price', () => {
  assert.deepEqual(validatePriceForm({ skuCode: 'A', minQuantity: 1, unitPrice: 0, currency: 'USD', unit: 'kg' }), ['单价必须大于 0'])
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd platform-web && node --test src/modules/catalog/catalogForm.test.js`

Expected: FAIL with missing `catalogForm.js`.

- [ ] **Step 3: Implement frontend helpers and API functions**

Create these exact frontend modules:

```js
// catalogForm.js
export function normalizePriceForm(input) {
  return {
    skuCode: String(input.skuCode || '').trim().toUpperCase(),
    minQuantity: Number(input.minQuantity),
    maxQuantity: input.maxQuantity === '' || input.maxQuantity == null ? null : Number(input.maxQuantity),
    unitPrice: Number(input.unitPrice),
    currency: String(input.currency || '').trim().toUpperCase(),
    unit: String(input.unit || '').trim().toLowerCase(),
    customerType: String(input.customerType || 'all').trim().toLowerCase()
  }
}

export function validatePriceForm(input) {
  const errors = []
  if (!String(input.skuCode || '').trim()) errors.push('SKU不能为空')
  if (!(Number(input.minQuantity) > 0)) errors.push('起订数量必须大于 0')
  if (!(Number(input.unitPrice) > 0)) errors.push('单价必须大于 0')
  if (!String(input.currency || '').trim()) errors.push('币种不能为空')
  if (!String(input.unit || '').trim()) errors.push('单位不能为空')
  return errors
}
```

```js
// api/catalog.js
import request from './index'
export const getCatalogVersions = () => request.get('/v1/catalog/versions')
export const createCatalogDraft = () => request.post('/v1/catalog/versions/draft')
export const publishCatalogVersion = id => request.post(`/v1/catalog/versions/${id}/publish`)
export const getProducts = versionId => request.get(`/v1/catalog/versions/${versionId}/products`)
export const saveProduct = (versionId, data) => request.post(`/v1/catalog/versions/${versionId}/products`, data)
export const getSkus = versionId => request.get(`/v1/catalog/versions/${versionId}/skus`)
export const saveSku = (versionId, data) => request.post(`/v1/catalog/versions/${versionId}/skus`, data)
export const getPriceRules = versionId => request.get(`/v1/catalog/versions/${versionId}/prices`)
export const savePriceRule = (versionId, data) => request.post(`/v1/catalog/versions/${versionId}/prices`, data)
export const getFreightRules = versionId => request.get(`/v1/catalog/versions/${versionId}/freight`)
export const saveFreightRule = (versionId, data) => request.post(`/v1/catalog/versions/${versionId}/freight`, data)
export const previewCatalogImport = file => { const body = new FormData(); body.append('file', file); return request.post('/v1/catalog/import/preview', body, { headers: { 'Content-Type': 'multipart/form-data' } }) }
export const commitCatalogImport = jobId => request.post(`/v1/catalog/import/${jobId}/commit`)
export const resolveQuote = data => request.post('/v1/catalog/quote/resolve', data)
```

Add to `platform-web/package.json`:

```json
"test:catalog": "node --test src/modules/catalog/catalogForm.test.js"
```

- [ ] **Step 4: Run frontend form tests**

Run: `cd platform-web && npm run test:catalog`

Expected: all frontend catalog tests PASS.

- [ ] **Step 5: Commit the frontend contract**

```bash
git add platform-web/package.json platform-web/src/api/catalog.js platform-web/src/modules/catalog/catalogForm.js platform-web/src/modules/catalog/catalogForm.test.js
git commit -m "feat: add catalog frontend api contract"
```

### Task 8: Product and pricing management page

**Files:**
- Create: `platform-web/src/views/Catalog/CatalogView.vue`
- Create: `platform-web/src/views/Catalog/components/ProductSkuPanel.vue`
- Create: `platform-web/src/views/Catalog/components/PriceRulePanel.vue`
- Create: `platform-web/src/views/Catalog/components/FreightRulePanel.vue`
- Create: `platform-web/src/views/Catalog/components/ImportPreviewDialog.vue`
- Create: `platform-web/src/views/Catalog/components/QuoteTester.vue`
- Modify: `platform-web/src/router/index.js`
- Modify: `platform-web/src/components/Layout/AppSidebar.vue`

- [ ] **Step 1: Add the route and menu first, then verify the missing component fails the build**

Router child:

```js
{
  path: 'catalog',
  name: 'Catalog',
  component: () => import('@/views/Catalog/CatalogView.vue'),
  meta: { title: '产品与报价' }
}
```

Sidebar item:

```vue
<el-menu-item index="/catalog">
  <el-icon><Goods /></el-icon>
  <template #title>产品与报价</template>
</el-menu-item>
```

Run: `cd platform-web && npm run build`

Expected: FAIL because `CatalogView.vue` does not exist.

- [ ] **Step 2: Implement the page shell and version bar**

Create the page shell with this data flow (keep styling scoped and consistent with `OrdersView.vue`):

```vue
<template>
  <div class="catalog-view">
    <el-alert title="已发布版本用于 AI 正式报价；草稿修改不会影响线上回复。" type="warning" :closable="false" />
    <div class="toolbar">
      <el-select v-model="versionId" @change="reloadKey++">
        <el-option v-for="item in versions" :key="item.id" :label="`${item.version_no} · ${item.status}`" :value="item.id" />
      </el-select>
      <el-button v-if="canManage" @click="createDraft">新建草稿</el-button>
      <el-button v-if="canManage && selected?.status === 'draft'" type="primary" @click="publish">发布</el-button>
      <el-button v-if="canManage" @click="importVisible = true">导入文件</el-button>
    </div>
    <el-tabs v-if="selected" v-model="tab">
      <el-tab-pane label="产品与SKU" name="products"><ProductSkuPanel :key="`p-${reloadKey}`" :version="selected" /></el-tab-pane>
      <el-tab-pane label="价格规则" name="prices"><PriceRulePanel :key="`r-${reloadKey}`" :version="selected" /></el-tab-pane>
      <el-tab-pane label="运费规则" name="freight"><FreightRulePanel :key="`f-${reloadKey}`" :version="selected" /></el-tab-pane>
      <el-tab-pane label="报价校验" name="quote"><QuoteTester /></el-tab-pane>
    </el-tabs>
    <ImportPreviewDialog v-model="importVisible" @committed="loadVersions" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { getCatalogVersions, createCatalogDraft, publishCatalogVersion } from '@/api/catalog'
import { useUserStore } from '@/stores/user'
import ProductSkuPanel from './components/ProductSkuPanel.vue'
import PriceRulePanel from './components/PriceRulePanel.vue'
import FreightRulePanel from './components/FreightRulePanel.vue'
import ImportPreviewDialog from './components/ImportPreviewDialog.vue'
import QuoteTester from './components/QuoteTester.vue'
const userStore = useUserStore()
const versions = ref([]), versionId = ref(''), tab = ref('products'), importVisible = ref(false), reloadKey = ref(0)
const canManage = computed(() => ['admin', 'supervisor'].includes(userStore.userInfo?.role))
const selected = computed(() => versions.value.find(item => item.id === versionId.value))
async function loadVersions() { const res = await getCatalogVersions(); versions.value = res.data || []; versionId.value = versions.value.find(v => v.status === 'draft')?.id || versions.value.find(v => v.status === 'published')?.id || ''; reloadKey.value++ }
async function createDraft() { const res = await createCatalogDraft(); await loadVersions(); versionId.value = res.data.id }
async function publish() { await ElMessageBox.confirm('发布后 AI 精确报价将使用该版本，确认发布？', '发布确认', { type: 'warning' }); await publishCatalogVersion(versionId.value); await loadVersions() }
onMounted(loadVersions)
</script>
```

- [ ] **Step 3: Implement product/SKU, price and freight panels**

Use this concrete implementation for `PriceRulePanel.vue`:

```vue
<template>
  <section>
    <el-button :disabled="version.status !== 'draft'" @click="open">新增价格规则</el-button>
    <el-table :data="rows"><el-table-column prop="sku_code" label="SKU"/><el-table-column prop="customer_type" label="客户类型"/><el-table-column prop="min_quantity" label="起订量"/><el-table-column prop="unit_price" label="单价"/><el-table-column prop="currency" label="币种"/></el-table>
    <el-dialog v-model="visible" title="价格规则"><el-form><el-input v-model="form.skuCode"/><el-input-number v-model="form.minQuantity"/><el-input-number v-model="form.unitPrice"/><el-input v-model="form.currency"/></el-form><template #footer><el-button type="primary" @click="save">保存</el-button></template></el-dialog>
  </section>
</template>
<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getPriceRules, savePriceRule } from '@/api/catalog'
import { normalizePriceForm, validatePriceForm } from '@/modules/catalog/catalogForm'
const props = defineProps({ version: { type: Object, required: true } })
const rows = ref([]), visible = ref(false)
const form = reactive({ skuCode: '', customerType: 'retail', minQuantity: 1, maxQuantity: '', unit: 'kg', currency: 'USD', unitPrice: 0 })
async function load() { const res = await getPriceRules(props.version.id); rows.value = res.data || [] }
function open() { Object.assign(form, { skuCode: '', customerType: 'retail', minQuantity: 1, maxQuantity: '', unit: 'kg', currency: 'USD', unitPrice: 0 }); visible.value = true }
async function save() { const errors = validatePriceForm(form); if (errors.length) return ElMessage.error(errors[0]); await savePriceRule(props.version.id, normalizePriceForm(form)); visible.value = false; await load() }
onMounted(load)
</script>
```

In `ProductSkuPanel.vue`, use two explicit forms and handlers:

```js
const products = ref([]), skus = ref([])
const productForm = reactive({ productCode: '', name: '', description: '', status: 'active' })
const skuForm = reactive({ productCode: '', skuCode: '', specification: '', packaging: '', weightKg: null, coverageMinSqm: null, coverageMaxSqm: null, status: 'active' })
async function load() { const [productRes, skuRes] = await Promise.all([getProducts(props.version.id), getSkus(props.version.id)]); products.value = productRes.data || []; skus.value = skuRes.data || [] }
async function saveProductForm() { if (!productForm.productCode.trim() || !productForm.name.trim()) return ElMessage.error('产品编码和名称不能为空'); await saveProduct(props.version.id, { ...productForm, productCode: productForm.productCode.trim().toUpperCase() }); await load() }
async function saveSkuForm() { if (!skuForm.productCode.trim() || !skuForm.skuCode.trim()) return ElMessage.error('产品编码和SKU不能为空'); await saveSku(props.version.id, { ...skuForm, productCode: skuForm.productCode.trim().toUpperCase(), skuCode: skuForm.skuCode.trim().toUpperCase() }); await load() }
```

In `FreightRulePanel.vue`, use this form and save handler:

```js
const rows = ref([])
const form = reactive({ regionCode: '', deliveryTerm: 'OTHER', baseWeightKg: 0.5, baseFee: null, incrementalWeightKg: 0.5, incrementalFee: null, currency: 'USD', manualConfirmation: false })
async function load() { const res = await getFreightRules(props.version.id); rows.value = res.data || [] }
async function save() { if (!form.regionCode.trim()) return ElMessage.error('国家或区域编码不能为空'); await saveFreightRule(props.version.id, { ...form, regionCode: form.regionCode.trim().toUpperCase(), currency: form.currency.trim().toUpperCase() }); await load() }
```

Both templates bind exactly these fields to Element Plus inputs and disable all save/edit buttons when `version.status !== 'draft'`.

- [ ] **Step 4: Implement import preview and exact quote tester**

Implement the two components around these exact submit handlers:

```js
// ImportPreviewDialog.vue script core
const file = ref(null), preview = ref(null)
async function runPreview() { if (!file.value) return ElMessage.warning('请选择文件'); const res = await previewCatalogImport(file.value.raw || file.value); preview.value = res.data }
async function commit() { await ElMessageBox.confirm('确认将预览内容写入新的草稿版本？', '导入确认', { type: 'warning' }); await commitCatalogImport(preview.value.id); emit('committed'); emit('update:modelValue', false) }
```

```js
// QuoteTester.vue script core
const form = reactive({ skuCode: '', quantity: 1, currency: 'USD', customerType: 'retail', regionCode: '', deliveryTerm: 'OTHER', weightKg: null })
const result = ref(null)
async function submit() { if (!form.skuCode || !(Number(form.quantity) > 0)) return ElMessage.warning('请填写SKU和数量'); const res = await resolveQuote({ ...form, skuCode: form.skuCode.trim().toUpperCase() }); result.value = res.data }
```

The import template displays `preview.previewJson` counts and warnings. The quote template displays `status`, `versionId`, `priceRuleId`, `freightRuleId`, `unitPrice`, `goodsAmount`, `freightAmount`, `totalAmount`, and `reason` without hiding audit identifiers.

- [ ] **Step 5: Run frontend tests and production build**

Run: `cd platform-web && npm run test:catalog && npm run build`

Expected: unit tests PASS and Vite build completes without unresolved imports or template errors.

- [ ] **Step 6: Commit the management page**

```bash
git add platform-web/src/router/index.js platform-web/src/components/Layout/AppSidebar.vue platform-web/src/views/Catalog
git commit -m "feat: add product and pricing management ui"
```

### Task 9: Seed preview, integration verification and operator documentation

**Files:**
- Create: `rag-server/scripts/preview-catalog-import.js`
- Create: `docs/catalog-pricing-operations.md`
- Modify: files from Tasks 1-8 only when a named verification command identifies a defect.

- [ ] **Step 1: Create a read-only import preview script**

```js
const fs = require('fs')
const path = require('path')
const { parseCatalogBuffer } = require('../src/modules/catalog/catalog.import.service')

const filename = path.resolve(process.argv[2])
const preview = parseCatalogBuffer({ filename, buffer: fs.readFileSync(filename) })
console.log(JSON.stringify({
  filename: path.basename(filename), sourceHash: preview.sourceHash,
  accepted: preview.accepted, products: preview.products.length,
  skus: preview.skus.length, priceRules: preview.priceRules.length,
  freightRules: preview.freightRules.length, warnings: preview.warnings
}, null, 2))
```

- [ ] **Step 2: Run the preview against the canonical existing price document**

Run:

```powershell
cd rag-server
node scripts/preview-catalog-import.js src/private/knowledge-sources/3a1953c4-166f-4c66-8a5c-7f1de3d433e2.md
```

Expected: `accepted:true`, non-zero price/freight counts, and no database change.

- [ ] **Step 3: Verify duplicate sources are detected by hash**

Run:

```powershell
Get-ChildItem src/private/knowledge-sources/*.md | ForEach-Object { node scripts/preview-catalog-import.js $_.FullName }
```

Expected: the five identical price files report the same hash and are imported only once when committed through the UI.

- [ ] **Step 4: Perform local API/UI integration without publishing production data**

Start MySQL/Redis and `rag-server` using the project's existing environment configuration, sign in as admin, create a draft, preview the canonical Markdown, commit it to the draft, edit one price, and use Quote Tester. Do not click “发布” against a production-connected database during this verification.

Expected: the edit persists in the draft; the published version and existing customer replies remain unchanged.

- [ ] **Step 5: Write the operator guide**

Write these concrete sections in `docs/catalog-pricing-operations.md`: `权限`, `新建草稿`, `导入并检查警告`, `编辑产品与价格`, `报价校验`, `发布`, `回滚`, `故障处理`. Under `回滚`, specify: create a new draft cloned from the desired historical version, verify it in Quote Tester, then publish it; never mutate a published row. Include the rule: prices are never edited in Markdown after import.

- [ ] **Step 6: Run the full regression set**

Run:

```powershell
cd rag-server
npm run test:catalog
node --test src/modules/messaging/inboundMessage.service.test.js src/modules/cloud-gateway/cloudGateway.test.js
cd ..\platform-web
npm run test:catalog
npm run build
```

Expected: every test PASS and production build succeeds.

- [ ] **Step 7: Commit the verified vertical slice**

```bash
git add rag-server/scripts/preview-catalog-import.js docs/catalog-pricing-operations.md
git commit -m "docs: add catalog pricing operations"
```

## Completion criteria

- Staff can create a draft and maintain products, SKUs, price tiers and freight rules in `platform-web`.
- Existing Markdown/Excel can be previewed safely; unrecognized files cannot create catalog rows.
- Publishing is atomic and auditable; runtime quote resolution reads only the published version.
- A quote with no matching active rule returns `manual_confirmation` and no invented number.
- Existing WhatsApp, conversation-pool and cloud-gateway tests remain green.
- No enterprise WeChat settings, existing “客服1号”, or production catalog version are changed by this plan's local verification.
