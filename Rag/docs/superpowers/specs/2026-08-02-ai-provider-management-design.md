# AI Provider Management Design

## Goal

Add secure, admin-only model provider management to AI configuration. Phase one supports DashScope and establishes adapters for future OpenAI, DeepSeek, and OpenAI-compatible providers.

## Architecture

`providerCredentialService` encrypts provider credentials with AES-256-GCM using a server-owned base64 key. API responses expose only source, configured state, and the last four characters. `providerRegistry` exposes a stable interface: connection test, model discovery, balance discovery, and runtime OpenAI-compatible client settings.

DashScope uses its documented deployment-model listing API. Balance is reported as unsupported until DashScope provides a stable API suitable for API-key authentication. Existing `DASHSCOPE_API_KEY` remains a read-only fallback.

## API

- `GET /api/v1/conversations/ai-provider`: sanitized provider status and capabilities.
- `PUT /api/v1/conversations/ai-provider`: replace the database credential.
- `DELETE /api/v1/conversations/ai-provider/credential`: remove the override and fall back to environment configuration.
- `POST /api/v1/conversations/ai-provider/test`: validate a supplied or stored credential.
- `POST /api/v1/conversations/ai-provider/models/sync`: refresh and cache model IDs.
- `GET /api/v1/conversations/ai-provider/balance`: return balance or an explicit unsupported result.

## UI

The first AI configuration band shows provider status, masked credential, endpoint, connection test, model sync, and balance capability. Model fields become searchable, allow custom IDs, and use the synchronized list when available.

## Safety

Only admins may access provider operations. Secrets and upstream response bodies never enter API responses or logs. Database overrides are authenticated ciphertext. Clearing affects only the override; environment credentials cannot be cleared from the UI.

## Failure Handling

Model sync retains the last successful list. Unsupported balance is distinct from zero balance. Runtime provider failures continue through existing review fail-closed and reply retry behavior.

## Verification

Unit tests cover authenticated encryption, masking, provider capability normalization, validation, API-safe projections, model-list normalization, and frontend form behavior. Server tests and the production frontend build must pass.
