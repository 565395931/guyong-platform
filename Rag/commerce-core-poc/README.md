# Commerce Core PoC

This isolated Vendure `3.7.2` application validates the multi-platform order projection design in
`../docs/commerce-core-integration-spec.md`.

## Safety boundary

- Use only synthetic or redacted order fixtures.
- Do not configure real marketplace credentials or production callbacks.
- Do not expose the server or dashboard on a network. Vendure `3.7.2` currently brings unresolved
  high-severity production dependency advisories into this PoC.
- Use the dedicated `vendure_commerce_poc` database and a least-privilege database user.
- Keep `synchronize` disabled; schema changes must use migrations.

This repository is a contract and integration-boundary experiment, not a deployable baseline. Production
adoption stays blocked until the dependency audit is clean or each remaining advisory has a documented,
tested mitigation and explicit security approval. Never use `npm audit fix --force`: npm currently proposes
incompatible Vendure downgrades. `APP_ENV=production` is rejected in configuration validation so this gate
cannot be bypassed accidentally.

## Local checks

```powershell
npm test
npm run test:coverage
npm run typecheck
npm run build:server
npm audit --omit=dev --audit-level=high
```

Copy `.env.example` to `.env` only when a dedicated database and non-default secrets are ready. Missing
secrets intentionally abort startup with `CONFIG_MISSING`.
