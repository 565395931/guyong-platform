# Medusa Commerce Core Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated Medusa `2.18.0` comparison PoC that validates the shared external-order contract, measures adaptation complexity, and produces a security-backed Vendure-versus-Medusa decision.

**Architecture:** A vendor-neutral JSON Schema lives under `shared-protocol/commerce`. The Medusa PoC validates commands against that schema, maps them with pure immutable functions into order and reservation workflow inputs, and never starts Medusa or connects PostgreSQL during this phase.

**Tech Stack:** Node.js 24, TypeScript, Medusa 2.18.0, JSON Schema Draft 2020-12, Ajv, Vitest, npm audit.

---

### Task 1: Create the isolated Medusa backend

**Files:**
- Create: `commerce-core-medusa-poc/`
- Modify: `commerce-core-medusa-poc/package.json`
- Create: `commerce-core-medusa-poc/README.md`

- [ ] **Step 1: Generate without database or browser side effects**

Run from `Rag`:

```powershell
@('n') | npx create-medusa-app@2.18.0 commerce-core-medusa-poc --version 2.18.0 --skip-db --no-browser --use-npm
```

Expected: answer `N` to the CLI's Storefront prompt and create a Medusa backend without database creation, migration, seed, browser launch, or Storefront installation.

Observed fallback: GitHub access was unavailable after two bounded attempts, so the backend skeleton is recreated from Medusa's official compatible starter file structure while all executable dependencies continue to come from exact npm-published `2.18.0` packages. No third-party mirror is permitted.

- [ ] **Step 2: Pin the Medusa package family**

Replace floating Medusa ranges in `package.json` with exact `2.18.0` versions. Add exact compatible test dependencies and scripts:

```json
{
  "scripts": {
    "test:contract": "vitest --config vitest.contract.config.ts run",
    "test:contract:coverage": "vitest --config vitest.contract.config.ts run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "3.2.7",
    "ajv": "8.18.0",
    "vitest": "3.2.7"
  }
}
```

- [ ] **Step 3: Document and enforce the safety boundary**

`README.md` must state: synthetic data only; no `.env`; no PostgreSQL; no migrations; no service/Admin startup; no `npm audit fix --force`; deployment prohibited until the audit gate passes.

- [ ] **Step 4: Install and capture the initial audit**

Run:

```powershell
npm install
npm audit --omit=dev --audit-level=high
```

Expected: exact lock file created; audit result recorded even when the command exits non-zero.

### Task 2: Publish the vendor-neutral command schema

**Files:**
- Create: `shared-protocol/commerce/external-order-projection-command.schema.json`
- Create: `commerce-core-medusa-poc/src/commerce/contract.test.ts`
- Create: `commerce-core-medusa-poc/src/commerce/contract.ts`

- [ ] **Step 1: Write failing schema tests**

Tests must assert acceptance of the current synthetic Taobao fixture and rejection of an unsafe numeric external order ID, empty lines, malformed decimal, lowercase currency, and unsupported normalized status.

```ts
expect(validateExternalOrderCommand(validCommand())).toEqual(validCommand())
expect(() => validateExternalOrderCommand({ ...validCommand(), externalOrderId: 9_223_372_036_854_775_807 }))
  .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
```

- [ ] **Step 2: Verify RED**

Run `npm run test:contract -- src/commerce/contract.test.ts`.

Expected: FAIL because `contract.ts` and the shared schema do not exist.

- [ ] **Step 3: Add the Draft 2020-12 schema**

The schema must set `additionalProperties: false`, require every command field, require decimal strings with `^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$`, require uppercase three-letter currency, and enumerate the seven normalized statuses from the Vendure contract.

- [ ] **Step 4: Implement immutable validation**

```ts
export class ContractError extends Error {
  readonly code = 'INVALID_INPUT'
}

export function validateExternalOrderCommand(input: unknown): Readonly<ExternalOrderProjectionCommand> {
  if (!validate(input)) throw new ContractError(formatAjvErrors(validate.errors))
  return deepFreeze(structuredClone(input))
}
```

- [ ] **Step 5: Verify GREEN**

Run `npm run test:contract -- src/commerce/contract.test.ts`.

Expected: all schema tests pass.

### Task 3: Map the command to Medusa workflow inputs

**Files:**
- Create: `commerce-core-medusa-poc/src/commerce/medusa-projection.ts`
- Create: `commerce-core-medusa-poc/src/commerce/medusa-projection.test.ts`

- [ ] **Step 1: Write failing mapping tests**

Use explicit lookup maps for sales channel, region, variant, inventory item, and location. Assert deterministic metadata, decimal-string amounts, one reservation template per line, no input mutation, `CHANNEL_NOT_MAPPED`, `SKU_NOT_MAPPED`, `TOTAL_MISMATCH`, `DISCOUNT_BREAKDOWN_REQUIRED`, and `TAX_BREAKDOWN_REQUIRED` failures.

- [ ] **Step 2: Verify RED**

Run `npm run test:contract -- src/commerce/medusa-projection.test.ts`.

Expected: FAIL because the projection mapper does not exist.

- [ ] **Step 3: Implement the pure mapper**

```ts
export type ProjectionErrorCode =
  | 'CHANNEL_NOT_MAPPED'
  | 'SKU_NOT_MAPPED'
  | 'TOTAL_MISMATCH'
  | 'DISCOUNT_BREAKDOWN_REQUIRED'
  | 'TAX_BREAKDOWN_REQUIRED'

export type MedusaProjectionPlan = Readonly<{
  order: Readonly<{ sales_channel_id: string; currency_code: string; items: readonly MedusaOrderItem[]; metadata: Readonly<Record<string, string>> }>
  reservations: readonly Readonly<{ inventory_item_id: string; location_id: string; quantity: number; line_external_id: string }>[]
}>
```

The implementation must scale and sum decimal strings with `BigInt`, compare line totals and the order total, reject non-zero discount or tax until the protocol carries Medusa-compatible breakdowns, resolve every mapping before returning, and recursively freeze the detached output.

- [ ] **Step 4: Verify GREEN and coverage**

Run:

```powershell
npm run test:contract
npm run test:contract:coverage
```

Expected: all tests pass; global statement, branch, function, and line coverage are each at least 80%.

### Task 4: Verify engineering and security gates

**Files:**
- Modify: `commerce-core-medusa-poc/README.md`
- Modify: `docs/commerce-core-integration-spec.md`

- [ ] **Step 1: Run static and build checks**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: both pass without starting a process that listens on a port.

- [ ] **Step 2: Scan for credential material**

Run `rg` over the PoC excluding `node_modules`, `dist`, and `coverage` for common API-key, access-token, and private-key patterns.

Expected: zero matches and no `.env` file.

- [ ] **Step 3: Run production dependency audit**

Run `npm audit --omit=dev --audit-level=high` and record exact low, moderate, high, and critical counts. Do not force-fix or add unverified transitive overrides.

- [ ] **Step 4: Update the comparison decision**

Add a dated Medusa evidence section to `docs/commerce-core-integration-spec.md` covering license, runtime services, build/test results, audit counts, mapping gaps, and a clear adopt/hold/reject decision.

### Task 5: Final verification

**Files:**
- Review all files created or modified by Tasks 1-4.

- [ ] **Step 1: Re-run the full local gate**

```powershell
npm run test:contract
npm run test:contract:coverage
npm run typecheck
npm run build
```

Expected: every command passes and no service is started.

- [ ] **Step 2: Confirm scope boundaries**

Confirm no `.env`, database, migration, real credential, network listener, Rag runtime edit, or Vendure PoC edit was created.

- [ ] **Step 3: Produce the decision packet**

Report exact test and coverage totals, both audit baselines, the selected core, remaining blocker, and the next reversible implementation step.
