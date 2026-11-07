# Writing a Floq plugin

Plugins extend Floq through declared contribution points only. This guide covers **Tier 1 (core) plugins**: written by Floq maintainers, reviewed like core code, compiled into the runtime and the app. Third-party (Tier 2) plugins are reserved in the manifest (`tier`, `apiVersion`) but not supported yet.

Start from the dev-only example: `runtime/src/plugins/example/` and `src/plugins/example/` (enable it with `FLOQ_DEV_PLUGINS=1` for the runtime; dev builds of the app load the UI half).

## 1. Layout

A plugin has a runtime half and a UI half linked by its `id`. They build separately (`runtime/` cannot see `src/`).

```
runtime/src/plugins/<id>/index.ts    definePlugin({ manifest, migrations, start, stop })
runtime/src/plugins/index.ts         BUILTIN_PLUGINS: add a static import
src/plugins/<id>/index.tsx           defineUiPlugin({ views, rightSidebarTabs, taskSources, settingsPanel })
src/plugins/index.ts                 UI_PLUGINS: add a lazy import
```

Manifests are plain objects (the example keeps its manifest inline in `index.ts`; a `plugin.json` imported into it works the same). `parseManifest` validates every manifest at boot. **An invalid manifest only disables that plugin**: it is logged and shown as `invalid` in Settings > Plugins, and everything else keeps running.

## 2. Manifest reference (`apiVersion` 1)

| Field | Rules |
|---|---|
| `id` | `2-32` chars: lowercase letters, digits, single hyphens, starts with a letter. Permanent: used in routes, the DB schema and view ids. |
| `name`, `description`, `version` | Display text; `version` is semver. |
| `apiVersion` | Must be `1`. The host refuses other majors. |
| `tier` | Must be `"core"`. |
| `scope` | `"user"`: each user switches it on and configures it. `"install"`: one admin-wide configuration (for example WAHA). |
| `icon` | A Tabler icon name registered in `src/plugins/icons.ts` (add one there if needed; unknown names fall back to a plug). |
| `secrets[]` | `{ name, description?, required? }`. `name` must match `^[A-Z][A-Z0-9_]{0,63}$`. A plugin can only read secrets it declares. They live in the plugin credential store, never in the user's vault (see [Credentials](#credentials-plugin-secrets)). |
| `network.allow[]` | Hosts `ctx.fetch` may reach: exact (`api.example.com`) or `*.suffix` with at least two labels after `*.`. No IP addresses. HTTPS only. |
| `settings[]` | `{ key, type, label, description?, required?, options? }`. Types: `text`, `url`, `number`, `boolean`, `select` (needs `options`), `secretRef`. Rendered by the host in Settings > Plugins and validated on save. |
| `contributes.views[]` | `{ id, label, icon? }`. Appear in the main navigation below Terminal, after a separator. |
| `contributes.taskSources[]` | `{ id, label, view: "generic" \| "custom" }`. Shown as a source group in the Tasks board picker. |
| `contributes.rightSidebarTabs[]` | `{ id, label, icon? }`. Appended after the four core tabs. |
| `contributes.routes` | `true` lets the plugin register `/v1/plugins/<id>/api/*` routes. |
| `contributes.internalRoutes` | `true` lets agents call the plugin (`floq plugin call`). |
| `contributes.webhooks[]` | Hook names exposed unauthenticated at `/v1/plugins/<id>/hooks/<name>/<installToken>`. |
| `contributes.mcpServers[]` | `{ name, type, command/args/env \| url/headers }`. Installed per user as `plugin-<id>-<name>`. **A server that carries a secret (`envSecrets`, `headerSecrets`) is rejected** with "plugin secrets cannot be passed into the agent sandbox": an MCP server runs inside the agent's sandbox, so a value handed to it is a value the agent can read. A runtime MCP gateway that keeps the value server-side is a planned follow-up. |
| `contributes.skills[]` | Folder names under `<plugin dir>/skills/<name>/` (a `SKILL.md` plus text files). They are listed read-only in the bundled scope with a `plugin:<id>` origin, and **copied into the agent home** (global scope, Claude and Codex) of each user the plugin is on for, so agents can load them. Disabling removes the copies. `runtime/scripts/copy-plugin-assets.mjs` (part of `npm run build`) copies the folders next to the compiled plugin. |
| `contributes.migrations` | `true` if the plugin owns a database schema. |
| `contributes.settingsPanel` | `true` if the UI half supplies a custom panel below the generic form. |
| `contributes.canvasNodes` | Reserved. Rejected in v1. |

Unknown keys, undeclared secret references, bad ids, duplicate ids, `tier: "external"` and `apiVersion` other than 1 are rejected. Error messages name the field, never the value.

## 3. Lifecycle

`available` → `enabled` ⇄ `disabled`; three failed starts (with 1 s and 5 s back-off) mark a plugin `failed`. At boot a failure keeps the plugin enabled so the next boot retries it. Enabling and disabling a plugin never overlap (they are serialized per plugin). `stop()` is called on disable and on runtime shutdown. There is no uninstall: plugins ship with the build.

Migrations are an ordered array `{ id, sql }` applied in one transaction together with their ledger rows. Applied ids never change; only append. Each plugin gets the schema `plugin_<id with - → _>`; in SQL, `{{p}}` expands to `""` in schema mode and to the table prefix `plugin_<id>__` in fallback mode, so write `CREATE TABLE {{p}}tickets (...)`. Every table needs a `user_id` column.

## 4. PluginContext (runtime)

| Member | What it does |
|---|---|
| `routes.get/post/put/delete(pattern, handler)` | `/v1/plugins/<id>/api/<pattern>`. Runs as the calling user. `handler({ userId, params, query, body })`; the return value is the JSON body. Throw `HttpError` for other statuses. Decoded params never contain `/`, `\`, NUL or dot segments. |
| `internalRoutes.call(pattern, handler)` | Agent-callable (`floq plugin call <id> <path> [--json BODY]`). Always POST on the wire; the handler also receives `sessionId`. Output is sanitized before the agent sees it. |
| `webhooks.on(name, handler, { verify? })` | Unauthenticated hook. The host checks the install token (constant time), caps the body at 256 KiB, rate-limits, then runs `verify` (for example an HMAC) and the handler. There is no calling user; use `secrets.getInstall`. |
| `secrets.get(userId, name)` | `scope:"user"` only: that user's own credential, declared names only; **throws for an install-scope plugin**. Reads are audited, sampled to at most one row per secret per minute. |
| `secrets.getInstall(name)` | `scope:"install"` only: the installation's credential (owner `'*install*'`, set by any administrator and kept when that admin leaves). Throws for a user-scope plugin. |
| `settings.get(userId)` | The validated settings values (install config for `scope:"install"`). |
| `fetch(url, init)` | HTTPS only, allow-listed hosts, no redirects, 15 s timeout, 5 MiB cap. Returns `{ status, ok, headers, bytes, text(), json() }`. |
| `db.query(sql, params)` / `db.forUser(userId)` | Runs in a transaction scoped to the plugin schema. `forUser` makes `$1` the user id. |
| `kv.get/set(userId, key)` | Small JSON state per plugin and user (cursors, sync markers). |
| `taskSources.register({ id, provider })` | `provider.list(userId, { query, cursor })` and `provider.get(userId, externalId)`. Items are normalized to `ExternalTask`: `{ sourceId, externalId, title, status, statusCategory: "todo"\|"doing"\|"done", assignee?, priority?, url, updatedAt, fields[] }`. Listings are cached 60 s per user. |
| `events.publish(userId, name, data)` | Frame to that user's open apps only. JSON, at most 64 KiB (throws otherwise). The UI listens with `usePluginEvent`. |
| `approvals.request({ userId, action, detail })` | Asks the user and resolves `"approved"` (single use) / `"denied"` / `"expired"`. Shown as "Plugin: <name>". It waits at most 10 minutes, then withdraws the request and resolves `"expired"`; it is also withdrawn when the plugin stops. The request is stored (audit trail, survives a restart). **Do not await it inline in a `routes` handler**: the client gives up after 90 s. Use it from `internalRoutes` (the agent CLI waits) or return `202` and act from the resolved promise. |
| `log.debug/info/warn/error` | Tagged with the plugin id; revealed secret values are redacted (raw, URL-encoded and JSON-escaped). |
| `schedule(intervalMs, fn)` | Runs never overlap; the minimum interval is 1 s; cleared on stop. |

Anything a handler returns, and any `HttpError` message it throws, is scrubbed of the secrets the plugin revealed. Other errors become a generic `500 plugin_error` and are logged scrubbed.

## 5. Contribution points (UI)

`defineUiPlugin({ views, rightSidebarTabs, taskSources, settingsPanel })`: component maps keyed by the ids declared in the manifest. A component without a manifest declaration, or a declaration without a component, is ignored. A plugin contributes only while the server reports it `enabled` for the signed-in user; a component that throws renders a contained error state (`PluginBoundary`) and the rest of Floq keeps working. Task sources with `view: "generic"` are rendered by the host (`ExternalTaskList`: search, status filter, rows, detail sheet, "Open in <source>"); `"custom"` sources supply their own component. External items never mix into native board search.

## 6. The UI kit and design rules

Plugin UI imports **only** from `react`, `@tabler/icons-react`, `@/plugins/kit`, `@/plugins/sdk` and its own folder (`scripts/test-plugin-imports.mjs` enforces it; plugins cannot ship CSS files).

- `@/plugins/kit` re-exports the shared primitives (Button, Badge, Card, Table, Empty, Field, Input, Textarea, Select, Switch, Checkbox, Tabs, Tooltip, Dialog, AlertDialog, Sheet, DropdownMenu, Skeleton, Kbd, `toast`) plus `PluginPage`, `PluginState`, `ExternalTaskRow`, `PluginBoundary`, `usePlugins`, `usePluginApi`, `usePluginEvent`.
- Use `PluginPage` for the view shell and `PluginState` for `loading | empty | error | not-configured | disabled`. Error states keep what the user typed and offer Retry.
- Use semantic tokens only (`bg-card`, `text-muted-foreground`, `border-border`, …; the list is `src/plugins/tokens.ts`). No hex or `rgb()` colors, no palette utilities like `bg-red-500`, no `backdrop-filter`, no keyframes or ambient motion. Theme, material, reduced motion and forced colors come from the host.
- Icons are Tabler only, by name in the manifest. Plugin views follow the same density as core pages: 13-14 px rows, 28-32 px headings.
- Credentials are declared in `secrets[]` and entered by the user in **Settings > Plugins > Configure > Credentials** (write-only). Never ask for a token in a plugin settings field, and never link users to the Secrets page for them.

## Credentials (plugin secrets)

Plugin credentials are **not vault secrets.** They have their own table (`plugin_secrets`), their own encryption key and their own API; the vault (`floq vault`, the Secrets page, `/internal/vault/*`, session env injection) never sees them.

- **Where users enter them:** Settings > Plugins > Configure > **Credentials**: one row per declared secret with a Present/Missing badge, Set/Replace (a password input, cleared after every save) and Remove (with a confirmation). Values are write-only: no screen and no API returns one. For an `install`-scope plugin only administrators edit; members see "Configured by an administrator". The not-configured state of a task source links to Settings > Plugins.
- **API** (user token only, never an agent token): `GET /v1/plugins/:id/secrets` (presence only), `PUT|DELETE /v1/plugins/:id/secrets/:name`. `GET /v1/plugins` keeps `secrets[].present`.
- **Encryption:** AES-256-GCM with a subkey derived from the runtime key (HKDF, info `plugin-secrets/v1`) and AAD `plugin-secret:v1:<plugin>:<owner>:<name>`, so a ciphertext copied to another plugin, owner, name or to the vault does not decrypt. `user` scope is owned by the user, `install` scope by `'*install*'`.
- **Reading them:** only host code, through `ctx.secrets.get(userId, name)` (user scope) or `ctx.secrets.getInstall(name)` (install scope). A plugin cannot read another plugin's credentials.
- **They never enter the agent sandbox.** An agent's CLI, its MCP servers and every process in its sandbox run as the same user with the same session token, so anything placed there is readable by the agent. That is why plugin MCP servers that need a secret are rejected (see `contributes.mcpServers[]`), and why agents use a plugin through server-side routes (`floq plugin call`), which return results, never credentials. Results and errors are scrubbed of the secrets the plugin revealed (raw, URL-encoded, JSON-escaped).
- **Audit:** `set` and `remove` are always recorded; reads are sampled to one row per secret per minute. Rows older than 90 days are deleted, and a plugin keeps at most 5000 rows (the oldest go first). Audit rows hold plugin, owner, name, action and actor, never a value.
- **Migration from the vault:** older installs kept plugin credentials in the vault. The runtime copies them into the plugin store and deletes the vault copy, once per (plugin, owner, name). It keeps the vault copy while it cannot read the user's MCP configs or while one of the user's own MCP entries still references `${vault:NAME}`, and retries when that user lists plugins, opens the secrets list or enables a plugin (and at boot), so the copy goes as soon as it is safe. The user sees a one-time notice on Settings > Plugins and the Secrets page; notices name secrets only.
- **Trust:** a plugin runs inside the runtime process and could read `plugin_secrets` directly. The store protects credentials from agents and from the vault surface, not from malicious installed code (see the trust model above).

## 7. Security checklist

- [ ] Every secret is declared in `secrets[]`; values are read only through `ctx.secrets`.
- [ ] Never put a token in a URL, error message or log field you build yourself. The host scrubs known values, but prefer headers.
- [ ] `network.allow` lists exact hosts; no `*.com`, no IPs.
- [ ] Anything an agent triggers that writes outward (sends a message, edits a ticket) goes through `ctx.approvals.request`. A click in the UI is consent already.
- [ ] Table names and SQL use `{{p}}`; every table has `user_id`; queries filter by it.
- [ ] Route params are untrusted: validate before putting them in upstream URLs.
- [ ] Webhook handlers verify a signature when the sender supports one and never echo input in errors.
- [ ] Large or slow work uses `ctx.schedule` or `async` I/O, never synchronous loops (plugins run in the runtime process).
- [ ] Remember the trust model: Tier 1 code is fully trusted and `search_path` scoping is a guard rail, not a sandbox. Code review (CODEOWNERS on `runtime/src/plugins/` and `src/plugins/`) is the gate.

## 8. Testing recipe

Runtime (see `runtime/test/pluginHost.test.mts`, `pluginContext.test.mts`, `pluginsServer.test.mts`):

1. Build with `cd runtime && npx tsc -p tsconfig.json` (the plain `npm run build` also runs `prisma generate`, which needs `DATABASE_URL`).
2. Use `fakePool()` from `runtime/test/fixtures/plugins/pgPool.mts` (PGlite behind a `pg.Pool`-shaped object) and construct a `PluginHost` with your definition, an `encryptionKey` (any 32-byte buffer) and a `sink` to capture logs. Seed a credential with `host.secrets.set(pluginId, ownerId, name, value, actor)` (`ownerId` is the user id, or `'*install*'` for an install-scope plugin).
3. Call `host.enable(id, "admin")`, then drive routes with `host.handle({...})` or through `createRuntimeServer` like `pluginsServer.test.mts`. Mock `fetchImpl` for upstream calls and assert the token never appears in errors or logs.
4. Run: `node --import ./node_modules/.ptystub/register.mjs --import tsx --test test/<file>.test.mts`.

Frontend: `npx tsc --noEmit`, then `node --test scripts/test-plugin-host.mjs scripts/test-plugin-kit.mjs scripts/test-plugin-imports.mjs scripts/test-plugin-tokens.mjs`.

## 9. Installable plugins (floq-plugins)

Floq ships no plugins compiled in (apart from the dev-only example); an **administrator** can install, update and uninstall plugins from **Settings > Plugins > Browse plugins**. Packages come from the `victorl1m/floq-plugins` repository; neither the Tauri app nor the runtime image needs a rebuild. Installed plugins use the same machinery as the ones in this guide (same manifest, `PluginContext`, kit), so everything above applies.

### Trust

> Installed plugins run inside the Floq runtime with its full privileges and inside the app with your session. Floq checks that the package is the exact one published in floq-plugins (sha256), and gives plugins a limited API (declared secrets only, allow-listed hosts, their own database schema). That API is a guard rail, not a sandbox: malicious plugin code could read any user's data, the encryption key and secrets, or your session token. Install only plugins you trust as much as Floq itself.

What is enforced: integrity against the catalog (sha256 of the exact bytes), https and host pinning of every download, admin-only install with a typed confirmation and no agent path (there is no `/internal` route or `floq` command for it), manifest validation, and per-plugin crash containment. What is **not** enforced: isolation of code that is actually malicious. The trust root is the floq-plugins repository and its GitHub account. **Next step (not in v1):** an Ed25519 signature over `index.json`, with the public key compiled into the runtime, so that a compromised repository or CDN alone cannot push code.

### Package format (`<id>-<version>.floqpkg.json`, one file per release, at most 5 MiB)

```jsonc
{ "format": 1,
  "manifest": { /* plugin.json */ },
  "runtime": "<ESM JavaScript, one file, no imports>",
  "ui": "<ESM JavaScript, one file>" | null,
  "skills": { "waha": { "SKILL.md": "…" } } }
```

- **`runtime`** is bundled (esbuild, ESM, platform node) and must not import host modules. It exports `default` like a built-in: `{ migrations?, start(ctx), stop() }`. Use `ctx.httpError(status, code, message)` instead of importing `HttpError`; `definePlugin` is an identity function, so it can be inlined. The manifest always comes from the verified `manifest` field, never from the bundle.
- **`ui`** is bundled for the browser with `react`, `react/jsx-runtime`, `@/plugins/kit` and `@/plugins/sdk` mapped to `globalThis.__FLOQ_PLUGIN_RT__` (`{ react, jsx, kit, sdk }`), so the plugin uses the app's one React and one kit. Tabler icons are **not** shared: call `kit.resolvePluginIcon("IconSend")`. Plugins that only use the host's generic views (task sources, the settings form) set `"ui": null`.
- **`skills`** maps skill name to relative file path to text. Paths follow the skill-package rules (relative, no `..`, no odd characters), at most 120 files and 512 KiB per skill. Every skill named in `contributes.skills` must be present.
- The package is attached to a GitHub release tagged `<id>-v<version>`. The catalog, `index.json` on `main`, lists `id, name, version, apiVersion, description, icon, scope, secrets, network, contributes, minFloq, package, sha256`. The package URL must be `https://github.com/victorl1m/floq-plugins/releases/download/…`; a redirect is followed only to `objects.githubusercontent.com` or `release-assets.githubusercontent.com`. Downloads time out after 30 s and are capped at 5 MiB. `FLOQ_PLUGIN_CATALOG` overrides the catalog URL for admins and ops.

### What the runtime does

Verify everything first (sha256, JSON shape, `parseManifest`, id and version equal the catalog entry, supported `apiVersion`, not a built-in id, skill paths), then store the package in `floq_plugin_packages` (the database is the source of truth and survives container rebuilds), write `runtime.mjs` (mode 0600) under `${FLOQ_PLUGIN_DIR:-/var/lib/floq/plugins}/<id>/<sha256>/` and `import()` it. A broken package becomes `invalid` in the list, with the reason; the runtime still boots. A fresh install is **off** until an admin enables it. The UI bundle is served to signed-in users of an enabled plugin at `GET /v1/plugins/:id/ui.js` (with `X-Floq-Plugin-Sha256`), checked against the checksum in the plugin list and imported from a Blob. This needs `blob:` in the app's `script-src` (one change in `tauri.conf.json`, shipped with the next app release).

- **Update**: only to a strictly newer catalog version (equal is "up to date", older is refused). The new package is verified and loaded as a new file; the old version is stopped and, if the plugin was on, the new one starts (running new migrations). If it cannot start, the previous version is restored and keeps running. Node cannot unload the old module, so it stays in memory until the next restart.
- **Uninstall**: turns the plugin off (removing its MCP servers and skill copies), then deletes the package row and cache folder. **Data is kept** (schema `plugin_<id>`, settings, kv), so installing it again picks it up. **Delete data** is a separate admin action with a typed confirmation; it drops the schema and the settings rows and is refused while the plugin is running.
- Built-in plugins (compiled into the runtime; today only the dev-only `example`) can be neither installed over nor uninstalled. Movidesk, Azure DevOps and WAHA are no longer built in: each lives in its own repository (`victorl1m/floq-plugin-<id>`) and is installed from Settings > Plugins > Browse plugins.

### Installing from a GitHub repository (any owner)
In Browse plugins an administrator can paste `https://github.com/<owner>/<repo>`: a Floq plugin, or one of their own. Floq asks the GitHub release API for the repository's **newest published release** and takes its single `*.floqpkg.json` asset, which must be a release download of that same repository (never a branch or a file in the tree). The same limits apply as for catalog packages: https, `github.com`, redirects only to the pinned CDN hosts, 30 s, 5 MiB, manifest validation, no built-in id, skill path rules.

There is no catalog checksum, so nobody vouches for the bytes except the repository's owner. Floq therefore works in two steps: **review** (download and verify, store nothing, show the id, version, secrets, hosts, contributions and the sha256) and **install** (the admin types the plugin id, and the request carries the reviewed sha256: if the release changed in between, nothing is installed). The repository is recorded, so an update can only come from the same repository. The warning for this path is stronger: the code is from an author Floq cannot vouch for.

**Updates are manual.** When the app opens, an administrator gets a toast if an installed plugin has a newer version (`GET /v1/plugins/updates`, read-only). Nothing is installed until the admin clicks **Check for update**, reviews the new sha256 and confirms. Only a strictly newer version of the same plugin id from the same repository is accepted.

### Publishing checklist

- [ ] `plugin.json` is valid for `parseManifest` and `id`/`version` match the release tag.
- [ ] The runtime bundle has no imports (`ctx` is the only way to reach the host) and `ui` imports only the four shared specifiers.
- [ ] Every skill folder has a `SKILL.md`; paths are relative and safe.
- [ ] The package is under 5 MiB, and `sha256` in `index.json` is the hash of the released file.
- [ ] Tests ran against the **built** package, with mocked network and no credentials.
- [ ] The version is strictly greater than the last release (the runtime refuses downgrades).
