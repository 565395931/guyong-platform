# Warehouse MVP Operations

Status: implemented in Rag; production rollout remains gated by the verification items below.

## Scope

- Warehouse master data: create and list active/inactive warehouses.
- Inventory ledger: receive positive stock or record a negative adjustment.
- Availability: `available = onHand - reserved`; reserved stock cannot be reduced by adjustment.
- Reservations: reserve multiple SKU lines, release a reservation, or fulfill it.
- Idempotency: stock changes require a caller-supplied `idempotencyKey`; reservation keys are unique.
  Repeated reservation keys are accepted only when warehouse, order reference, SKU lines, and
  quantities exactly match the original request. Conflicting reuse is rejected.
- Audit: every stock mutation writes an immutable ledger row with operator and reference metadata.
- Quantity precision: service quantities use scaled integers and are converted to exact decimal
  strings at the MySQL boundary; floating point arithmetic is not used.
- Warehouse lifecycle: inactive warehouses remain readable, but reject new receipts, adjustments,
  and reservations. Existing reservations can still be released or fulfilled.
- Platform SKU mapping: each `(channel, account, external SKU)` maps to one canonical warehouse SKU;
  inactive or missing mappings block order allocation.
- Order fulfillment: allocation resolves mapped order lines, creates an idempotent warehouse
  reservation, and shipping fulfills the reservation before creating the logistics record.
- Logistics writeback: shipping creates a durable `fulfillment_writeback_outbox` event. A configured
  channel adapter can acknowledge the tracking number; failures remain retryable instead of being
  silently discarded.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/warehouses` | List warehouses |
| POST | `/api/v1/warehouses` | Create a warehouse |
| GET | `/api/v1/warehouses/{code}/inventory` | List SKU inventory |
| GET | `/api/v1/warehouses/{code}/inventory/{skuCode}` | Read one SKU |
| GET | `/api/v1/warehouses/{code}/reservations?status=reserved` | List reservations by state |
| POST | `/api/v1/warehouses/{code}/inventory/adjust` | Receive or adjust stock |
| GET | `/api/v1/warehouses/{code}/ledger?skuCode=...&operationType=...&page=1&pageSize=20` | Query paginated stock ledger |
| POST | `/api/v1/warehouses/{code}/reservations` | Reserve order lines |
| POST | `/api/v1/warehouses/reservations/{key}/release` | Release reservation |
| POST | `/api/v1/warehouses/reservations/{key}/fulfill` | Consume reserved stock |
| GET | `/api/v1/platform-sku-mappings` | List platform-to-warehouse SKU mappings |
| POST | `/api/v1/platform-sku-mappings` | Create or update a mapping |
| PATCH | `/api/v1/platform-sku-mappings/{id}/status` | Enable or disable a mapping |
| POST | `/api/v1/fulfillment/orders/{id}/reserve` | Resolve SKU mappings and reserve order stock |
| POST | `/api/v1/fulfillment/orders/{id}/ship` | Fulfill stock, create shipment, and dispatch writeback |

Read access is available to agent, supervisor, and administrator roles. Mutations require
supervisor or administrator access. The route returns generic errors for unexpected failures and
does not expose SQL or credentials.

Ledger page size is limited to 100. Operation type is restricted to `receipt`, `adjustment`,
`reserve`, `release`, and `fulfill`; warehouse, SKU, type, limit, and offset are passed to MySQL
as bound parameters. The frontend shows the ledger with SKU/type filters, signed deltas, operator,
business reference, timestamp, and pagination.

## Release gates

Before production use, run the schema migration against a dedicated test database, execute a
concurrency test with two workers reserving the same SKU, connect the approved platform SKU
mapping and fulfillment/shipment write-back, and complete backup/restore and retention review.

The frontend lockfile has been refreshed so the next clean install resolves the identified high
severity production advisories. Because active local processes currently hold the esbuild binary,
the live dependency directory was not replaced. Schedule a maintenance-window clean install and
repeat build/browser verification. ECharts 5 still has one moderate advisory; upgrading to ECharts
6 requires a separate compatibility test before production rollout.

## 2026-08-14 acceptance evidence

- Real MySQL dual-connection reservation race: `warehouse.mysqlConcurrency.test.js` passed; one
  reservation committed, the competing transaction blocked on `FOR UPDATE` and was rejected, and
  the final reserved quantity was `1.000`.
- Real MySQL fulfillment integration: `orderFulfillment.mysql.integration.test.js` passed in an
  isolated database; mapped SKU, reservation, shipment, inventory decrement, and succeeded
  writeback outbox were all read back from MySQL.
- Backup/restore drill: `tools/warehouse/backup-restore-drill.ps1` passed with an isolated marker
  database. The generated SQL artifact is under `artifacts/backup-restore/`.
- Clean frontend install: isolated `npm ci` installed 104 packages and the production build passed.
  The production lockfile still reports one moderate ECharts XSS advisory that needs a breaking
  ECharts 6 upgrade and compatibility test.
- Browser E2E: `platform-web/scripts/warehouse-commercial-e2e.mjs` passed on desktop and mobile
  viewports with screenshots under `artifacts/e2e/warehouse-commercial/`.
