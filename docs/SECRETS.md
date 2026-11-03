# Keychains (scoped agent secrets) and canvas notes

## Keychains (scoped secrets)

A keychain is a named wallet of secrets drawn as a node on the canvas (`keychains`, `keychain_secrets`, `keychain_links`; secrets and links cascade with the keychain, links also with the session). The user wires it to agents; only linked agents receive its secrets. Orchestrated children do not inherit them.

- API (write-only, no endpoint returns a value): `GET /v1/keychains` (all, with `projectName`), `GET|POST /v1/projects/:projectId/keychains`, `PATCH|DELETE /v1/keychains/:id`, `PUT|DELETE /v1/keychains/:id/secrets/:name`, `POST /v1/keychains/:id/links {sessionId}`, `DELETE /v1/keychains/:id/links/:sessionId`. Mutations return the updated keychain with `appliesOnNextStart: true` when a live session is affected. `SessionSummary.secretCount` = distinct secret names injected for the agent, from one grouped query.
- Names: `^[A-Z_][A-Z0-9_]{0,63}$`, minus reserved names (PATH, HOME, LD_*, NODE_*, GIT_*, FLOQ_*, ANTHROPIC_*, CLAUDE*, CODEX*, OPENAI_*, ... see `runtime/src/secrets.ts`). Values 1..16384 bytes, 100 per keychain.
- At rest: the same AES-256-GCM primitive and `FLOQ_ENCRYPTION_KEY` as the vault (`crypto.ts`), random IV per value, AAD `user:keychain:<keychainId>:name`. A separate table is used because the vault is a flat per-user name -> value store. Without a valid key, storing and revealing throw (fail closed).
- Delivery: env vars when a linked session starts or resumes (after base and vault env, never over reserved names; when several linked keychains define a name the later-created keychain wins), plus files at `~/.floq/secrets/<sessionId>/<NAME>` (dir 0700, files 0400, shard uid) refreshed on link/unlink/secret change so `floq secret get NAME` / `floq secret list` work in a running session. A live process env cannot change; it updates on next start.
- Global vault: the existing vault (Secrets screen, `${vault:NAME}`) is unchanged and global. Entries with expose "env" are already injected as env into every agent at start; `floq secret get/list` additionally reads those (scope `global`) through `/internal/secrets/global`. Tool-only entries are never returned.
- Leak prevention (best effort): values are never logged (only `secret.set` / `secret.delete` / `keychain.link` with ids and names); exact values of the agents' linked keychains are replaced by `[secret:NAME]` in agent-message previews and `floq ask/wait/check` output. Values under 4 characters, and transformed values (base64, split, partial), are not caught.

## Threat model

Protects against exposure through the UI/API, database dumps, and accidental logging. It does NOT protect against the agent itself: an agent can read its own secrets (env and files) and could exfiltrate them, and other agents of the same user share the shard uid and can read the files. Attach the least privilege that the task needs and prefer short-lived tokens.

## Notes

`canvas_notes` (`GET/POST /v1/projects/:projectId/notes`, `PATCH/DELETE /v1/notes/:id`); project `none` is the scratch canvas. Text up to 20000 chars, w/h 120..2000, colors yellow|blue|green|pink|purple|gray.
