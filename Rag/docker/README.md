# Deployment templates

These Compose files contain no deployment passwords or API keys. Provide secrets
through the shell environment, a deployment secret manager, or an untracked
`.env` in the relevant Compose directory before starting containers.

| Template | Required environment variables |
| --- | --- |
| `mysql/docker-compose.yml` | `MYSQL_ROOT_PASSWORD` |
| `waha/docker-compose.yml` | `WAHA_API_KEY_1`, `WAHA_API_KEY_2` |

Compose fails when a required variable is unset or empty. Use independent random
values. Existing MySQL volumes retain their initialized credentials; changing the
template or environment is not a database-password rotation. No container needs
to be restarted merely to produce a source archive.

Copy `rag-server/.env.example` to a private `rag-server/.env` and fill database,
JWT, encryption and required provider settings. Set the backend `WAHA_INSTANCES`
JSON `apiKey` values to the corresponding per-instance Compose keys. JSON strings
in dotenv files do not expand nested environment references automatically.

The checked-in WAHA hook account IDs and proxy endpoint are deployment examples
and must be checked against the target installation before launch. The legacy
`generate-config.js --apply` tool can generate deployment-specific values, so
review its outputs before committing or distributing them.

Never include `.env`, container volumes, browser sessions, database dumps or
customer media in a source handoff. `tools/release/package-source.ps1` excludes
those paths and performs a credential preflight before creating an archive.
