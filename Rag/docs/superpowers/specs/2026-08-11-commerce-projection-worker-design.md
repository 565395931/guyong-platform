# Commerce Projection Worker Design

## Goal

Turn the existing idempotent order projection coordinator into a durable enterprise execution path without coupling Rag to a single commerce engine.

## Decisions

- Keep `channel_event_inbox` as the source of normalized commands. Projection jobs store only `command_ref`; customer and address payloads are not duplicated.
- A worker lists due jobs, atomically claims one with a time-bounded lease, resolves its command, and delegates business validation to `ProjectionCoordinator`.
- Retryable failures use capped exponential backoff. Once `maxAttempts` is reached, the job becomes `terminal_failed` and is treated as dead-letter work requiring an operator replay decision.
- A crashed `processing` job is recovered only after its lease expires. The downstream commerce port must remain idempotent because a crash can occur after the downstream commit but before the local ledger commit.
- Store timestamps are ISO-8601 UTC strings in domain objects and MySQL `DATETIME(3)` values in persistence.
- Multi-worker safety is enforced by conditional updates. Listing work is advisory; only the worker that wins `claimJob` may execute it.

## Runtime Flow

1. The synchronous ingestion path creates a `processing` job and projects immediately.
2. A retryable error records `nextAttemptAt` using the configured retry policy.
3. `ProjectionWorker.runOnce()` recovers expired leases, lists due jobs, and claims each job atomically.
4. The command source resolves `command_ref`. The coordinator verifies the command belongs to the claimed job before calling the commerce port.
5. Success stores the order link and job outcome in one transaction. Exhausted or invalid work is terminal and remains queryable for operations.

## Security And Operations

- Dependency and transport error details are replaced with stable public messages before persistence.
- Batch size, lease duration, and retry limits are bounded and validated at construction.
- Worker results expose counts and job identifiers, not order payloads.
- Production enablement remains gated on a commerce engine with no unresolved high or critical runtime advisories.

## 2026-08-12 Channel Mapping Update

- A shared connector boundary now converts complete normalized order detail into protocol v2 and
  validates monetary invariants before inbox storage.
- The boundary requires explicit shipping, discount, and tax data, including explicit zero values.
  Sparse increment notifications remain raw-only; contradictory amounts fail the sync and retain
  its cursor.
- Command identity uses the external event ID, while external version ordering defaults to the
  normalized event timestamp. These concerns are intentionally separate.
- Taobao, Pinduoduo, 1688, Douyin, Xiaohongshu, WeChat Shop, and Kuaishou adapters call this shared
  boundary. This does not mean their raw platform fields are fully mapped. The authoritative status
  is maintained in `docs/commerce-channel-capability-matrix.md`.
- Certified raw-field mappers are supplied as explicit function objects through the adapter registry;
  dynamic module loading is rejected. A mapper must return a complete projection or `null` for a
  deliberate raw-only event. The operator endpoint
  `GET /api/v1/channel-events/projection-summary?channel=<channel>` reports RBAC-scoped readiness.
- Pinduoduo incremental order numbers are now hydrated with `pdd.order.information.get` before
  normalization. Detail identity mismatch or malformed detail prevents cursor advancement.
- Taobao, Pinduoduo, and 1688 JSON clients retain decimals and unsafe integers as exact strings;
  safe integers remain numbers for pagination and status handling.
