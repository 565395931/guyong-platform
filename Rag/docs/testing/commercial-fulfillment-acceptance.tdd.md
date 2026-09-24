# Commercial Fulfillment Acceptance Evidence

Date: 2026-08-14

## Journeys

- Operations maps a platform SKU to a canonical warehouse SKU and can disable it without deleting audit history.
- A paid order is allocated only when every line has an active mapping and sufficient inventory.
- Shipping consumes the reservation, records a tracking number, and leaves a durable platform writeback event when an adapter is unavailable or fails.
- Two concurrent reservations cannot oversell one inventory row.
- A database backup can be restored into a fresh database and verified without touching the source.

## RED/GREEN evidence

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Mapping normalization and inactive blocking | service module missing | 4 mapping tests pass |
| Fulfillment reserve/ship/writeback contract | service module missing | 5 fulfillment tests pass |
| Real row-lock race | isolated runner initially lacked env and failed | real dual-connection test passes |
| Real mapping-to-shipment flow | fixture used invalid positional Sequelize placeholders, then enum mismatch surfaced | isolated MySQL integration passes |
| Backup restore | Windows `SOURCE` path initially parsed backslashes incorrectly | PowerShell drill passes after forward-slash normalization |
| Browser warehouse workflow | Playwright browser executable was not selected and API route matcher intercepted source modules | desktop/mobile E2E passes |

## Commands

```text
RUN_REAL_MYSQL=1 node --test src/modules/warehouse/warehouse.mysqlConcurrency.test.js
RUN_REAL_MYSQL=1 node --test src/modules/order-fulfillment/orderFulfillment.mysql.integration.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File tools/warehouse/backup-restore-drill.ps1
npm ci --ignore-scripts --no-audit --prefix <isolated-frontend-copy>
npm run build --prefix <isolated-frontend-copy>
E2E_BROWSER_EXECUTABLE=<local Chromium> node platform-web/scripts/warehouse-commercial-e2e.mjs
```

## Release blockers

- Configure and contract-test each real channel shipment API adapter; the generic outbox is durable, but it does not pretend to have sent a carrier/platform request without an adapter.
- Run the migration on a staging clone of the production schema and validate rollback/restore.
- Upgrade ECharts to 6.x in a separate compatibility change to remove the remaining moderate XSS advisory.
