# Backend test boundaries

Run `npm test` from `rag-server` for the default isolated source suite. The runner
enumerates only `src/**/*.test.js`; it does not discover manual scripts under
`scripts/`. It uses an empty temporary working directory and replaces inherited
service credentials with dummy test values. MySQL and Redis default to unused
loopback port 9, and `RUN_REAL_MYSQL` is forced to `0`.

The default suite excludes these files explicitly:

| File | Reason and separate execution |
| --- | --- |
| `src/modules/warehouse/warehouse.mysqlConcurrency.test.js` | Creates/drops isolated fixture databases. Set `RUN_REAL_MYSQL=1` only against a dedicated MySQL test instance, then run `node --test` with this path. |
| `src/modules/order-fulfillment/orderFulfillment.mysql.integration.test.js` | Same MySQL requirements; verifies mapped reservation, shipment, and the writeback outbox. It does not certify a real platform shipment API. |
| `src/routes/customerConversationAuthorization.http.test.js` | Imports Redis/BullMQ at module load. Run separately with dedicated test Redis, test JWT and dummy MySQL settings; route database calls are stubbed. |
| `src/modules/rag/localParserService.html.test.js` | Imports a parser that calls `dotenv.config()`. Run `node --test <absolute-file-path>` from an empty directory with a clean test environment. |

The manual `scripts/test-after-hours-reply.js` and `scripts/test-nationality-service.js`
are live diagnostics. They read deployment configuration and may query customer
data or call a paid model. They are not part of the default suite.

New tests must mock external adapters and use disposable local HTTP servers. The
runner reduces accidental access to live configuration; it is not a network
sandbox. Tests that explicitly load a deployment `.env`, start workers, invoke
real adapters, or create database connections need their own opt-in harness.

The legacy administration regression suite verifies anonymous denial, stored
role enforcement, inactive account denial, supervisor statistics/skill access,
and administrator-only user operations. It does not start `src/app.js` or call a
real database.
