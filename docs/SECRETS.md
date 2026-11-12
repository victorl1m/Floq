# Secrets and canvas notes

## Vault

Secrets live in the per-user vault (Vault screen, `${vault:NAME}` in MCP configs): write-only over the API, encrypted with AES-256-GCM and `FLOQ_ENCRYPTION_KEY` (`runtime/src/vault.ts`, `crypto.ts`). Entries with expose "env" are injected as env into every agent at start; `floq secret get/list` additionally reads those through `/internal/secrets/global`. Tool-only entries are never returned; they are used through `floq-vault run`. Agents cannot create, change or delete vault secrets.

The earlier canvas **keychain** feature (scoped wallets wired to agents) was removed. Its tables (`keychains`, `keychain_secrets`, `keychain_secret_uses`, `keychain_links`) are left in the database untouched so no user data is lost; nothing reads or writes them, and a project's rows are removed when that project is deleted.

## Threat model

Protects against exposure through the UI/API, database dumps, and accidental logging. It does NOT protect against the agent itself: an agent can read the secrets exposed to it (env) and could exfiltrate them, and other agents of the same user share the shard uid. Attach the least privilege that the task needs and prefer short-lived tokens.

## Notes

`canvas_notes` (`GET/POST /v1/projects/:projectId/notes`, `PATCH/DELETE /v1/notes/:id`); project `none` is the scratch canvas. Text up to 20000 chars, w/h 120..2000, colors yellow|blue|green|pink|purple|gray.
