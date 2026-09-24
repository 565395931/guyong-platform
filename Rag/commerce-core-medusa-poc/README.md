# Medusa Commerce Core Comparison PoC

This isolated Medusa `2.18.0` backend evaluates the vendor-neutral external-order contract. The official
CLI could not clone its GitHub starter because GitHub was unreachable, so this directory uses the official
compatible starter structure and exact npm-published Medusa packages.

## Decision

Medusa is rejected as the current replacement for Vendure. On 2026-08-10, the production dependency audit
reported 78 advisories: 63 moderate, 15 high, and 0 critical. npm's suggested high-severity fixes include
breaking Medusa package downgrades, so no automatic force-fix or transitive override was applied.

The mapping PoC also found that non-zero order discounts and taxes require line-level adjustment and tax-rate
breakdowns that schema version 1 does not carry. These commands fail explicitly instead of inventing an
allocation.

## Safety boundary

- Use synthetic or redacted fixtures only.
- Do not create `.env`, connect PostgreSQL, run migrations, seed data, or start Medusa/Admin.
- Do not add marketplace credentials, production callbacks, or real customer data.
- Do not run `npm audit fix --force` or add unverified transitive overrides.
- Treat any high or critical production dependency advisory as a deployment blocker.
- `APP_ENV=production` is rejected by configuration validation.

## Local gates

```powershell
npm run test:contract
npm run test:contract:coverage
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```
