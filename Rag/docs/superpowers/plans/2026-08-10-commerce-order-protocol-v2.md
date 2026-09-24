# Commerce Order Protocol v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `@rag/commerce-protocol` package that validates external-order commands v1/v2 and safely migrates unambiguous v1 orders to v2.

**Architecture:** JSON Schema provides structural validation, while focused TypeScript functions enforce currency precision and cross-field monetary invariants with `BigInt`. The migration API accepts an explicit currency-exponent map and refuses historical orders whose discount or tax cannot be allocated safely.

**Tech Stack:** TypeScript 5.8, JSON Schema Draft 2020-12, Ajv 8.18, Vitest 3.2, Node.js 24.

---

### Task 1: Scaffold the protocol package and v2 schema

**Files:**
- Create: `shared-protocol/commerce/package.json`
- Create: `shared-protocol/commerce/tsconfig.json`
- Create: `shared-protocol/commerce/vitest.config.mts`
- Create: `shared-protocol/commerce/external-order-projection-command.v2.schema.json`
- Create: `shared-protocol/commerce/src/types.ts`

- [x] **Step 1: Create exact package metadata**

Use package name `@rag/commerce-protocol`, version `0.2.0`, exact Ajv `8.18.0`, TypeScript `5.8.2`, Vitest and coverage-v8 `3.2.7`. Add `build`, `test`, `test:coverage`, `typecheck`, and `audit:production` scripts.

- [x] **Step 2: Add v2 types**

Define `ExternalOrderProjectionCommandV2`, `ExternalOrderLineV2`, `ShippingLineV2`, `DiscountAllocation`, `TaxAllocation`, `CurrencyDefinition`, `CustomerIdentity`, and `ShippingAddress`. Every monetary value is a string; `schemaVersion` is the literal `2`.

- [x] **Step 3: Add the Draft 2020-12 schema**

The schema must reject unknown properties, negative amounts, empty order lines, numeric external order IDs, invalid currency codes, exponent outside `0..6`, and missing discount/tax arrays. It must require explicit funding attribution and `includedInSourcePrice`.

- [x] **Step 4: Install dependencies**

Run `npm install --prefer-offline --maxsockets=1` from `shared-protocol/commerce`.

Expected: exact lock file created; no high or critical production vulnerabilities.

### Task 2: Validate structure and monetary invariants with TDD

**Files:**
- Create: `shared-protocol/commerce/src/decimal.ts`
- Create: `shared-protocol/commerce/src/validator.ts`
- Create: `shared-protocol/commerce/src/validator.test.ts`
- Create: `shared-protocol/commerce/src/index.ts`

- [x] **Step 1: Write failing tests**

Create a v2 fixture with a discounted item, seller/platform attribution, one tax allocation, and a discounted/taxed shipping line. Assert immutable success and failures for unknown fields, negative amounts, excessive precision, line gross mismatch, line total mismatch, shipping total mismatch, summary mismatch, and order total mismatch.

- [x] **Step 2: Verify RED**

Run `npm test -- src/validator.test.ts`.

Expected: FAIL because `validator.ts` does not exist.

- [x] **Step 3: Implement decimal conversion**

`toScaledInteger(value, exponent)` validates exponent `0..6`, rejects precision beyond the exponent, and converts using string splitting plus `BigInt` only.

- [x] **Step 4: Implement v2 validation**

Compile the v2 schema with Ajv 2020. After structural validation, sum line, shipping, discount, and tax amounts as scaled integers and enforce all five invariants from the design. Return a recursively frozen structured clone. Errors use `INVALID_INPUT` or `TOTAL_MISMATCH` without including input values.

- [x] **Step 5: Verify GREEN and coverage**

Run `npm test` and `npm run test:coverage`.

Expected: all tests pass and every global coverage metric is at least 80%.

### Task 3: Add safe v1 migration with TDD

**Files:**
- Create: `shared-protocol/commerce/src/migrate-v1.ts`
- Create: `shared-protocol/commerce/src/migrate-v1.test.ts`
- Modify: `shared-protocol/commerce/src/index.ts`

- [x] **Step 1: Write failing migration tests**

Assert a zero-discount/zero-tax CNY v1 command becomes deterministic v2 with exponent `2`, one synthetic shipping line, empty allocation arrays, structured known customer/address fields, and a deeply frozen detached result. Assert stable failures for non-zero discount, non-zero tax, missing currency exponent, invalid v1 structure, line mismatch, and order-total mismatch.

- [x] **Step 2: Verify RED**

Run `npm test -- src/migrate-v1.test.ts`.

Expected: FAIL because `migrate-v1.ts` does not exist.

- [x] **Step 3: Implement migration errors and conversion**

Export `MigrationError` with codes `INVALID_INPUT`, `BREAKDOWN_REQUIRED`, `CURRENCY_EXPONENT_REQUIRED`, and `TOTAL_MISMATCH`. Validate v1 with the preserved v1 schema, resolve exponent from `Readonly<Record<string, number>>`, reject ambiguous totals, build v2, and call the v2 validator before returning.

- [x] **Step 4: Verify GREEN**

Run `npm test -- src/migrate-v1.test.ts` and then `npm test`.

Expected: migration tests and the full suite pass.

### Task 4: Verify and document the protocol boundary

**Files:**
- Create: `shared-protocol/commerce/README.md`
- Modify: `docs/commerce-core-integration-spec.md`

- [x] **Step 1: Run engineering gates**

Run `npm test`, `npm run test:coverage`, `npm run typecheck`, and `npm run build`.

Expected: all pass; every coverage metric is at least 80%.

- [x] **Step 2: Run security gates**

Run `npm audit --omit=dev --audit-level=high` and scan the package excluding `node_modules`, `dist`, and `coverage` for common key/private-key patterns.

Expected: no high/critical production dependency advisories and no credential matches.

- [x] **Step 3: Document compatibility**

README must explain v1 preservation, v2 formulas, migration refusal rules, public APIs, and the absence of database/platform dependencies. The main integration spec must mark protocol v2 complete and name Vendure projection-ledger integration as the next phase.
