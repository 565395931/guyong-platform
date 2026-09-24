# Commerce Channel Capability Matrix

Updated: 2026-09-17

This matrix distinguishes code registration from a production-capable connector. A channel is
projection-ready only when its connector supplies a complete normalized `projection` object and
the shared protocol v2 validator reconciles every amount.

| Channel | Event ingestion | Detail hydration | Protocol v2 projection | Production status |
|---|---|---|---|---|
| Taobao / Tmall | Incremental order and refund polling implemented | Current order API requests order records, but the platform-specific field mapper is not implemented | Shared projection boundary available; sparse raw records are not projected | Not production-ready |
| Pinduoduo | Incremental order-number and refund polling implemented | `pdd.order.information.get` hydration implemented with strict identity checks | Shared projection boundary available; platform detail mapper is not implemented | Not production-ready |
| Alibaba 1688 | Order and refund polling implemented | List response currently supplies order records | Shared projection boundary available; platform detail mapper and required address permission are not implemented | Not production-ready |
| Douyin shop | Signed webhook ingestion and shop scope checks implemented | Order-detail hydration is not implemented | Complete normalized webhook payloads can use protocol v2; ordinary ID notifications remain raw-only | Not production-ready |
| Xiaohongshu | Bridge adapter registered | External bridge must supply details | Shared projection boundary available | Bridge development required |
| WeChat shop / Channels | Bridge adapter registered | External bridge must supply details | Shared projection boundary available | Bridge development required |
| Kuaishou | Bridge adapter registered | External bridge must supply details | Shared projection boundary available | Bridge development required |
| WhatsApp | Message adapter only | Orders must come from a confirmed conversation-order workflow | No automatic commerce projection from payment screenshots | Human-confirmed workflow required |
| Amazon, eBay, Shopify, TikTok Shop, Shopee, Lazada, AliExpress | Not implemented | Not implemented | Protocol supports future connector output | Backlog; API approval and regional field study required |

## Connector Projection Contract

An order connector may attach `payload.projection` only after it has authoritative detail data.
The required fields are:

- currency code and exponent;
- normalized order status;
- at least one line with stable line ID, SKU, quantity, unit amount, gross amount, explicit
  discount allocations, explicit tax allocations, and total amount;
- explicit shipping gross amount, shipping discounts, and shipping taxes, including explicit zero
  values;
- declared order total;
- optional whitelisted customer and structured shipping-address fields.

Amounts are decimal strings. API clients preserve unquoted decimals and unsafe integers as strings;
safe integers such as pagination totals remain numbers. The mapper uses scaled `BigInt` arithmetic,
then validates the generated command with `@rag/commerce-protocol` before it enters the inbox.

Missing fields produce a raw-only event. Contradictory amounts produce a hard normalization failure
and retain the channel sync cursor for retry/operator investigation. The system never infers missing
discounts, taxes, shipping fees, status, or SKU values as zero/default business data.

Channel event list responses expose `projectionState` as `ready`, `raw_only`, or `not_applicable`.
The list query derives this state with a JSON path check and does not return the command or raw
payload. This allows operations to measure connector completeness without exposing order details.

## Enterprise Assembly And Operations

Certified platform mappers are injected as function objects during adapter initialization; production
configuration must provide an explicit whitelist entry, for example:

```js
initAdapters({ orderProjectionMappers: {
  pinduoduo: mapVerifiedPinduoduoOrder,
  taobao: mapVerifiedTaobaoOrder,
  alibaba1688: mapVerifiedAlibaba1688Order
} })
```

Only these three commerce channels accept mapper injection at this boundary. Unknown channel names,
non-functions, arrays, and malformed mapper output fail during initialization or event normalization;
there is no dynamic module loading from environment variables. A mapper returning `null` intentionally
keeps the event raw-only. A non-null result must satisfy the full protocol v2 monetary contract.

Operations can query the RBAC-scoped projection readiness summary:

```text
GET /api/v1/channel-events/projection-summary?channel=pinduoduo
```

The response is `{ total, ready, rawOnly }`, where `ready + rawOnly = total`. Agent users are limited
to accounts with an active seat binding; supervisors and administrators can see the channel total.
Internal database errors are returned as a generic failure and do not expose SQL or connector details.

## Production Gates

No channel may be marked production-ready until all of the following are evidenced:

1. Official application approval, scopes, rate limits, callback ownership, and data-retention terms.
2. Recorded platform detail fixtures covering all supported order states and money fields.
3. A platform-specific mapper with unit, contract, and replay tests at 80% or higher coverage.
4. Address/phone encryption and masking requirements implemented for the target region.
5. A dedicated test database end-to-end run through inbox, ledger, approved commerce core, inventory,
   fulfillment, and platform shipment write-back.
6. Zero unresolved critical/high runtime advisories in every production service, or a signed risk
   exception. The current Vendure 3.7.2 PoC does not satisfy this gate.

## Warehouse MVP (reviewed 2026-09-17)

Rag now includes a first-party warehouse module at `/api/v1/warehouses`. It is implemented as a
transactional MySQL inventory ledger beside the existing order/channel modules, rather than as a
second standalone ERP. The MVP covers warehouse master data, SKU on-hand/reserved/available
quantities, receipt and adjustment operations with idempotency keys, and reservation release or
fulfillment. The frontend exposes warehouse selection, inventory inspection, receiving, and
adjustment workflows at `/warehouses` for supervisors and administrators.

Platform SKU mapping and the order reservation/shipment flow are now implemented in Rag. The
2026-08-14 acceptance notes record a dual-connection reservation race and a mapping-to-shipment
integration run against isolated MySQL databases, plus a backup/restore drill and browser checks.
These are historical isolated-test results; this 2026-09-17 source review did not rerun the MySQL
drills. See `testing/commercial-fulfillment-acceptance.tdd.md` and `warehouse-mvp-operations.md`.

The historical fulfillment integration used an injected fake shipment writeback adapter. Its
succeeded outbox result is not evidence that any real platform received a tracking number. The
current production service assembly has no shipment writeback adapter, so events remain pending.
Repeated shipping requests now read the persisted outbox status; a missing event is reported as
`unknown`, rather than assumed successful. This read does not resend a platform request.

Production warehouse use still requires transactional recovery across inventory consumption,
shipment creation and outbox creation, order payment/cancellation eligibility checks, real channel
writeback adapters with retry processing, and staging validation against the production schema.
Procurement, transfers, cycle counts, batch/serial/expiry tracking and carrier label generation are
not covered by this MVP. The source review also corrected the release-ledger operation type to
match the MySQL `release` enum; the new regression is an offline schema-contract check, not a fresh
real-MySQL release test.
