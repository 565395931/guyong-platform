# Warehouse Commercial Ledger TDD Evidence

Date: 2026-08-13

## User journeys

- As an operations supervisor, I can trace every stock change by warehouse, SKU, operation type,
  operator, reference, and time.
- As an auditor, I receive bounded and paginated data instead of an unbounded table scan.
- As an inventory owner, decimal quantities remain exact across the service/MySQL boundary.
- As an administrator, I can deactivate a warehouse without losing read access or blocking the
  completion of existing reservations.

## RED and GREEN evidence

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Parameterized ledger query and count | `repository.listLedger is not a function` | warehouse repository tests pass |
| Ledger service validation/normalization | `service.listLedger is not a function` | warehouse service tests pass |
| Ledger API and frontend client | route/API contract missing | route and frontend API tests pass |
| Exact MySQL decimal persistence | expected `2.5`, received `2500` | exact decimal boundary test passes |
| Inactive warehouse mutation guard | expected rejection was missing | inactive warehouse test passes |

Commands used for the RED/GREEN cycle:

```text
node --test src/modules/warehouse/*.test.js
node --test src/api/warehouses.test.js
```

## Test specification

| What is guaranteed | Test target | Type |
|---|---|---|
| Ledger filters use named SQL replacements and page size/offset | `warehouse.repository.test.js` | integration contract |
| Scaled BigInt quantities persist as exact decimal strings | `warehouse.repository.test.js` | unit/integration boundary |
| Page/type/SKU filters are validated and results normalized | `warehouse.service.test.js` | unit |
| Ledger query is exposed through authenticated warehouse routes | `warehouse.routes.test.js` | route contract |
| Inactive warehouses reject new mutations | `warehouse.service.test.js` | unit |
| Warehouse UI includes filters, pagination, audit fields, and API client | `warehouseLedgerPanel.test.js` | frontend contract |

## Known gaps

- No DDL or tests were run against the existing MySQL service.
- Row-lock behavior is covered with fake executors, not a two-connection MySQL concurrency test.
- Browser visual/E2E verification requires an explicitly approved isolated application and test
  database; no local service was started during this work.
- The frontend production dependency lockfile has no high-severity advisory. One moderate ECharts
  advisory remains and requires a breaking major-version upgrade. Running `node_modules` was not
  replaced because active development processes hold the Windows esbuild binary; apply the lockfile
  with a clean install during a maintenance window, then repeat the build and browser regression.

## Final verification

- Warehouse backend regression: 43 tests passed.
- Warehouse frontend/navigation regression: 14 tests passed.
- Warehouse coverage: repository 98.97% lines, routes/schema 100% lines, service 97.54% lines.
- Frontend production build: passed.
- Backend production dependency audit: 0 vulnerabilities.
- Frontend lockfile production audit at high severity: passed; one moderate ECharts advisory remains.
