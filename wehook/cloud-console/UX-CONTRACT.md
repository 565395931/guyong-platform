# Lonely Warrior Cloud — UX Contract

## Roles and route ownership

- `operator`: may access `/admin` capabilities and mutate tenants, WeCom installation metadata and manual credit grants.
- `tenant_admin`: may access only its tenant account overview and issue/revoke local device credentials.
- Device credentials authenticate machine API calls only and never create browser sessions.
- Server-side authorization is authoritative. Forbidden direct access returns HTTP 403, not a disguised 404.

## Authentication

Browser sign-in uses username/password and an HttpOnly, Secure, SameSite=Strict signed session cookie. Invalid credentials always produce one generic error. Password values are never logged or persisted in browser storage. Session expiry returns the user to sign-in while preserving only the intended surface, not form secrets.

## Canonical UI map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | `.form-field` + `form[novalidate]` | `cloud.js` and this contract | sign-in / create / grant | browser + unit API tests |
| Modal | modal factory in `cloud.js` | `cloud.js` and this contract | standard / consequential | keyboard, Escape, focus restore |
| Toast | toast factory in `cloud.js` | `cloud.js` and this contract | success / warning / error | live region |
| Table | `.data-table` + table renderer | `cloud.js` and this contract | tenant / WeCom / ledger / devices | empty, loading, 20-row page |
| Scrollbar | global `cloud.css` | `DESIGN.md` | table region geometry only | computed style/manual |
| Auth | signed session cookie | server authorization | operator / tenant_admin | API integration tests |
| CRUD | JSON API + audit entry | server domain services | create / grant / issue | integration tests |

Native select and date pickers are not part of the first release. Add an authored shared primitive before introducing either when popup geometry becomes product-owned.

## Mutation lifecycle

All mutation buttons keep their width while busy, reject duplicate submit and expose `aria-busy`. On success, close the modal, refresh the owning dataset and announce a concise toast. On failure, preserve entered values and show an inline actionable error. The first invalid field receives focus.

Manual credit grants are consequential and require an app-owned confirmation step naming the tenant and number of credits. They are append-only; correction is a compensating ledger entry, never history deletion. Payment and automatic recharge are out of scope until a verified billing contract exists.

## Tables and state

Tables show at most 20 rows per page, with total/range copy and explicit previous/next controls. Loading, empty, no-result and failure states keep the table panel footprint stable. IDs may be truncated visually but retain an accessible full value. No secret value appears in a table.

## Connection states

Canonical labels are `在线`, `离线`, `待配置`, `需处理`. A signal dot accompanies every label. “在线” means a recently authenticated local device connection; it does not imply that WeCom callbacks or AI model calls are healthy.

## Recovery and audit

Every admin mutation records actor, action, target type/id, timestamp and non-secret metadata. API idempotency keys protect credit reserve/settle/cancel operations. A failed page request offers Retry. A 401 returns to sign-in; a 403 shows a dedicated permission message.
