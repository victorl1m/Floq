# Agent browser and claude.ai connectors

Status: design, approved scope (A + B). Author: Opus designer subagent, 2026-11-12. Repo state: v1.0.6 (d340a94).

Two features, shipped independently:

- **A. Agent browser.** One headless Chromium per user, inside that user's sandbox, with a persistent profile in the encrypted home. Agents drive it through a pinned MCP server (Claude Code and Codex). The user sees it live on the canvas as a **Browser** node and can click and type in it, for example to log in to a site the agent then uses.
- **B. claude.ai connectors.** Agents' Claude Code sessions load the user's claude.ai connectors natively. This already works today (see §B.1). The work is a Settings toggle, a read-only connector list and diagnostics.

---

## A. Agent browser

### A.1 Decisions

| Decision | Choice | Why |
|---|---|---|
| MCP server | **`@playwright/mcp@0.0.84`** (published 2026-10-31; bundles `playwright-core@1.65.0-alpha-2026-10-30`, Chromium 157.0.8103.15, revision 1252) | Has `--cdp-endpoint` and `--cdp-header`, so it attaches to *our* browser with an auth header instead of launching its own. Accessibility-snapshot tools work well for both Claude and Codex. `chrome-devtools-mcp@1.13.0` was rejected: it is oriented to one DevTools debugging session, and its connect-to-existing-browser path has no header auth. 0.0.85 is only 3 days old, so we do not pin it. |
| Chromium | **`chromium-headless-shell` revision 1252** (Chromium 157.0.8103.15): the exact build the pinned playwright-core expects, installed at build time into `/opt/floq/browsers`. See §A.12. | MCP and browser versions always match by construction. There are no downloads at runtime. The headless shell needs no GTK and no X server. |
| Core or plugin | **Core**, behind an admin switch and a per-user toggle | It needs an image binary, a sandboxed daemon tied to the shard lifecycle, a new WS route and a canvas node. `contributes.canvasNodes` is reserved and plugins cannot spawn sandbox processes. This goes against the "optional features as plugins" preference, and that is deliberate: we give it an off switch, not a plugin. |
| Browser topology | **One daemon per user** (`floq-browserd`), started on demand, stopped when idle | One profile means one login, which every agent of that user reuses. Chromium's `SingletonLock` forbids two processes on one profile anyway. |
| UI transport | CDP `Page.startScreencast` relayed by the runtime over a **new route on the existing WS server** (`/v1/browser/stream`) | No new port, the same auth as the other sockets. The client never sees raw CDP. The runtime forwards only an allowlisted message set. |
| Alternative rejected | Headed Chromium in the existing Xpra display (`display.ts`) | Display slots are per *session*, not per user. It needs Xvfb plus Xpra per user, a password in an iframe URL and port squatting probes. It is heavier and does not give agents a shared profile. |

### A.2 Architecture

```
 Floq app (canvas Browser node)
   │  WS /v1/browser/stream?token=…   (allowlisted JSON: frames, tabs, nav, input)
   ▼
 runtime: BrowserService (new, runtime/src/browser.ts)
   │  stdin/stdout pipe (JSON lines) ── spawned with ShardDriver.spawnPipe (user's bwrap, uid, netns)
   ▼
 floq-browserd (new, runtime/image/floq-browserd.mts, runs INSIDE the user's sandbox)
   ├─ chrome-headless-shell --remote-debugging-pipe --user-data-dir=~/.floq/browser/profile
   │      (CDP over fds 3/4: Chromium itself opens no TCP port)
   └─ ws://127.0.0.1:<ephemeral>/devtools/browser   (CDP multiplexer, requires "Authorization: Bearer <token>")
          ▲
          │ --cdp-endpoint + --cdp-header
   @playwright/mcp (stdio, launched by Claude Code / Codex through /usr/local/bin/floq-browser-mcp)
```

- **floq-browserd** owns Chromium. It speaks CDP to Chromium over `--remote-debugging-pipe` and multiplexes it:
  - **Agent endpoint:** a WS server on `127.0.0.1:0` (an ephemeral port, so nobody can squat it ahead of time). It accepts an upgrade only when the request has `Authorization: Bearer <token>`, compared in constant time, with a 256-bit token that is new on every daemon start. It refuses any request that carries an `Origin` header, which stops a web page from reaching it. It rewrites session ids so that several agents' CDP clients can share the one pipe. This is the same flat-session model Chrome uses internally; implement it with `Target.setAutoAttach` / `sessionId` routing and keep it under 400 lines.
  - **Control channel (stdin/stdout to the runtime):** a fixed command set (§A.5). It runs its own CDP session for screencast and input on the tab the user is viewing.
  - It writes `~/.floq/browser/endpoint.json` (mode 0600: `{port, pid, startedAt}; the token is never written to disk`). This is only for debugging. The runtime is the source of truth and hands the endpoint to the MCP wrapper.
- **floq-browser-mcp** (`/usr/local/bin`, a thin node launcher): calls `POST /internal/browser/ensure` with `FLOQ_API_URL` / `FLOQ_AGENT_TOKEN`, which Codex already forwards (`CODEX_FORWARDED_ENV`). It receives `{wsEndpoint, token}`, then execs `node /usr/local/lib/floq/playwright-mcp/cli.js --cdp-endpoint <ws> --cdp-header "Authorization: Bearer <token>" --output-dir ~/.floq/browser/output --image-responses omit`. The token is therefore never written to `~/.claude.json` or `config.toml`. When the user's browser toggle is off, it prints a clear MCP error and exits.
- **BrowserService** (runtime): `ensure(userId)`, `stop(userId, reason)`, viewer registry, idle timer and relay. It holds one daemon handle per user.

### A.3 Lifecycle

- **Start:** on the first `ensure` from an agent MCP wrapper, or when a viewer opens the Browser node. Both require the shard to be awake. A viewer opening the node wakes it through `manager.withUserShardActivity` semantics; an agent's shard is already awake.
- **Shard coupling:** while the daemon is running it counts as shard activity, so `scheduleLock` never locks a home that has Chromium on it. `sleepUser` (logout) and `shards.sleep` first call `browser.stop(userId)` and wait up to 5 s, then SIGKILL. **These are manager.ts touchpoints. The orchestrator (23d4fea3) has been told and has no objection. Its fallback implementer edits the same launch/resume path, so re-read manager.ts right before editing and keep the diff minimal.**
- **Idle shutdown:** the daemon stops after `FLOQ_BROWSER_IDLE_MS` (default 10 min) with zero agent CDP connections and zero viewers. A live connection with no traffic still counts as busy, but only up to 60 min, since agents can sit idle while still holding the MCP open.
- **Crash:** the daemon exits with Chromium. BrowserService marks the state `stopped`, viewers see "Browser stopped · Restart", and the next `ensure` restarts it. If Chromium leaves a stale `SingletonLock` after a crash, the daemon removes it only after checking that the pid in it is dead inside the sandbox.
- **Limits per user:** at most 20 open tabs (the oldest agent-opened background tab closes first) and Chromium `--js-flags=--max-old-space-size=1024`. The daemon runs under `prlimit` with an address-space cap; set it with `FLOQ_BROWSER_MEM_MB`, default 2048.

### A.4 Chromium flags

`--remote-debugging-pipe --user-data-dir=$HOME/.floq/browser/profile --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --password-store=basic --use-mock-keychain --disable-dev-shm-usage --window-size=1280,800`

**Chromium's own sandbox:** the daemon probes whether nested user namespaces work inside bwrap. If they do, it keeps the Chromium sandbox. If they do not, it adds `--no-sandbox` and logs `browser.chromium_sandbox_off` once. That is acceptable because the trust boundary is the bwrap + uid + encrypted-home sandbox: a compromised renderer gets what the user's agent already has, which is arbitrary code execution as that uid. Record this in the threat model; do not hide it.

### A.5 Protocols

**Runtime ↔ daemon (JSON lines over the pipe)**

| Direction | Messages |
|---|---|
| runtime → daemon | `hello`, `screencast.start {targetId, maxW, maxH, quality}`, `screencast.stop`, `frame.ack {n}`, `input.mouse {type, x, y, button, clickCount, modifiers}`, `input.wheel {x, y, dx, dy}`, `input.key {type, key, code, text, modifiers}`, `input.text {text}`, `nav.go {targetId, url}`, `nav.back`, `nav.forward`, `nav.reload`, `nav.stop`, `tab.new {url?}`, `tab.close {targetId}`, `tab.select {targetId}`, `shutdown` |
| daemon → runtime | `ready {port, token}`, `frame {n, targetId, jpeg(b64), w, h, scale}`, `tabs [{targetId, title, url, opener: "agent"\|"user"}]`, `nav {targetId, url, title, loading, canBack, canForward}`, `agentActivity {targetId, at}`, `clients {agents}`, `error {code}`, `exit` |

The daemon validates every inbound field: types, coordinates within the viewport, key names against an allowlist, and text at most 4 KiB. `nav.go` accepts only `http:`, `https:` and `about:blank`, never `file:`, `chrome:`, `devtools:`, `javascript:` or `data:`. Agents can still navigate anywhere through CDP; this rule covers the UI path only.

**App ↔ runtime (`/v1/browser/stream`)**: these are the same messages with the token stripped. The runtime adds `state {starting|running|stopped|disabled|unavailable}`. Auth works like `/v1/events` (`?token=`, the user from the bearer token, an Origin check against `FLOQ_ALLOWED_ORIGINS`). Each socket belongs to the calling user's daemon, so the route takes no user id.

**Backpressure:** the runtime acks a frame to the daemon only after `ws.bufferedAmount < 512 KiB`. Otherwise it drops the frame and acks the next one, so Chromium throttles itself. The screencast runs only while at least one viewer is visible: the app sends `screencast.stop` when the node is off-screen or `document.hidden`. Frame size is the node size × devicePixelRatio, capped at 1600×1200, JPEG quality 60. Input is rate-limited to 120 messages/s per socket.

### A.6 MCP registration (`mcpConfig.ts` path)

- Reserved entry name **`floq-browser`**. `validateMcpName` (mcpConfig.ts:104) refuses it for user-added servers, with the error "reserved for Floq's browser". Add a `RESERVED_MCP_NAMES` set.
- Spec: `{ name: "floq-browser", type: "stdio", command: "/usr/local/bin/floq-browser-mcp", args: [], env: {} }`. It carries no secrets, so it passes the plugin rule.
- Install and remove through the same sandboxed helper path that plugins use (`plugins/host.ts` `installMcp/removeMcp` → `SkillsService`, `MCP_FILE_SCRIPT`): `addToJsonConfig` for `~/.claude.json` and `addToTomlConfig` for `~/.codex/config.toml` (global scope; Codex's per-session `CODEX_HOME` picks it up through `mergeGlobalCodexMcp`).
- `BrowserService.syncMcp(userId)` runs when the per-user toggle changes, and also on shard wake when the stored desired state differs from the file. Compare entries with `sameJson`, so a user's hand-edited entry is reported rather than silently overwritten. It is idempotent.
- `--mcp-config` / `managed-mcp.json` were rejected. `managed-mcp.json` takes exclusive control of MCP in Claude Code: users could no longer add servers, and it **also blocks claude.ai connectors** (the `claudeai-mcp` "restricted by the organization's managed MCP configuration" path). Launch argv changes would mean more manager.ts churn.
- Agents learn about the browser from a short line in the wired system block: "A shared headless browser is available as MCP server floq-browser; the user can watch it and log in on the canvas Browser node. If a site needs a login, ask the user with floq decision request to log in there." Put it in `wiredContext.ts` or the subagent policy text, not in `manager.launch`.

### A.7 Settings and flags

- Admin/env: `FLOQ_AGENT_BROWSER=on|off` (default `on` when `/opt/floq/browsers` contains the pinned Chromium, `off` otherwise), `FLOQ_BROWSER_IDLE_MS`, `FLOQ_BROWSER_MEM_MB`. `capabilities.ts` reports `browser: "available"|"disabled"|"missing"`.
- Per user (`settings.ts` `PublicSettings`/`SettingsPatch`/`RuntimeProfile`): `agentBrowser: boolean`, default `true` when the admin allows it. Settings > Agents gets a "Browser" group with:
  - the toggle;
  - **Clear browser data**, which stops the daemon and removes `~/.floq/browser/profile` after a typed confirmation;
  - **Restart browser**;
  - status (running, agents connected, tabs).

### A.8 Canvas Browser node (frontend)

- `src/components/canvas/browser-node.tsx`, modeled on `app-window-node.tsx`: prefix `browser:`, `BROWSER_DEFAULT = { width: 900, height: 620 }`, `NodeResizer`, drag header, body `nodrag nowheel nopan`.
- There is **one Browser node per canvas**, because the browser belongs to the user. It appears when the user adds it from the canvas menu (`canvas-menu.tsx`: "Open browser") or automatically the first time an agent of this project connects. Geometry and the open/closed state are stored locally per project, like app windows.
- Chrome UI: a tab strip (titles, with an "agent" badge on agent-opened tabs), back/forward/reload/stop, a URL bar (Enter sends `nav.go`; bare text becomes `https://`), and an "Agent is using this tab" pulse driven by `agentActivity`. States: starting, stopped (Restart), disabled (a link to Settings), unavailable (the image has no browser).
- Viewport: a `<canvas>` (or `<img>`) painting JPEG frames, scaled with `object-fit: contain`. Pointer coordinates map back through the frame's `scale`. While the node is focused, keyboard events are captured: `keydown`/`keyup` go to `input.key`, printable text and IME `compositionend` go to `input.text`, and paste goes to `input.text` (text only). Canvas shortcuts (`canvas-kbd.tsx`) are suppressed while the browser viewport has focus. Esc blurs.
- Hook: `useBrowserStream(client)` in `src/lib/runtime/browser-stream.ts`, with reconnect and backoff like `app-window-tab.tsx` events. `RuntimeClient.browserStreamUrl()` and REST `browserStatus()`, `browserRestart()`, `browserClearData()`.
- Wire it into `agent-canvas-page.tsx` next to `appWindowNodeTypes` (line ~105) and `useCanvasAppWindows` (line ~879).

### A.8b Settings shows the version

Settings > Agents > Browser shows "Chromium 157.0.8103.15 (headless shell r1252) · Playwright MCP 0.0.84 · profile ~/.floq/browser/profile". The data comes from `GET /v1/browser` (`version`, read once at boot from `/opt/floq/browsers/VERSION.json`, §A.12.4).

### A.9 Threat model

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Another Floq user's sandbox connects to this user's CDP. Sandboxes share the container network unless `FLOQ_NETNS`. | Chromium has no TCP port (pipe only). The daemon port requires a 256-bit bearer token that only the runtime and that user's sandbox know. The port is ephemeral. Requests with an `Origin` header are refused. With `FLOQ_NETNS=required` the port is not even reachable. | A token could leak if the user's own agent prints it somewhere shared, which is the same class of leak as an agent leaking its own `FLOQ_AGENT_TOKEN`. |
| T2 | A web page (in this or any browser) attacks the CDP WS via DNS rebinding or a cross-origin WS. | Browsers cannot set `Authorization` on a WS. Any request with `Origin` is refused. Host header must be `127.0.0.1:<port>`. | None known. |
| T3 | The app/client gets raw CDP and with it arbitrary JS in logged-in sites. | The relay forwards only allowlisted message types (§A.5). The runtime never proxies CDP frames. | The user can do anything in the browser by hand, which is the point of the feature. |
| T4 | Cookies and the profile are readable by other users or by the operator at rest. | The profile is in the gocryptfs-encrypted home, mounted only into this user's sandbox and owned by the per-user uid. `--password-store=basic` means saved passwords are protected by the home encryption, not by a keyring. | The operator holds `FLOQ_ENCRYPTION_KEY`, which is already true for all user data. Document it in SECURITY.md. |
| T5 | Every agent of the user (all projects, all orgs) can use every site the user is logged in to. | Accepted by design and stated in the Settings copy: "Agents can use sites you log in to here." Per-user toggle off, Clear browser data. | Per-project profiles are a possible follow-up (`--user-data-dir` per project, more RAM). Not in v1. |
| T6 | A malicious page in the browser reaches internal services (runtime port, Postgres, other users' Xpra/dev ports) through loopback and private ranges. Sandboxes share the network by default. | Recommend `FLOQ_NETNS=required` for multi-user hosts (netns nft already blocks private ranges and the container's own addresses). Without netns, the daemon enables a browser-wide CDP `Fetch` interceptor (auto-attached to every target) that fails requests whose host is, or resolves to, loopback, link-local or RFC1918 space, unless `FLOQ_BROWSER_ALLOW_PRIVATE=1` (needed when the user previews an agent's dev server, which we expect to be common: offer it as a per-user setting later). Chromium's Local Network Access checks are a second layer, not the boundary. | Without netns, DNS that resolves to a private IP after the check (TOCTOU) remains possible. The same exposure already exists for agents running `curl`. The interceptor covers pages, iframes, dedicated, shared and service workers, and refuses on resolve failure, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) embedding private IPv4. A target whose `Fetch.enable` fails is closed (fail closed). **Not covered:** WebSocket and WebTransport handshakes (CDP `Fetch` does not see them), so `ws://127.0.0.1:<runtime-port>` stays reachable without netns; use `FLOQ_NETNS=required` on multi-user hosts. |
| T7 | A renderer exploit while Chromium runs `--no-sandbox`. | bwrap + per-user uid + per-user home is the boundary. The renderer gets the agent's privileges and nothing more. | This is called out explicitly; the Chromium sandbox stays on where userns allows it. |
| T8 | Prompt injection from web content steers the agent into using logged-in sites. | This is out of scope for transport. Mitigations: the wired-context line tells agents that page content is untrusted, outward actions still go through `floq approval`, and the user sees agent activity live. | This is inherent to agent browsing. |
| T9 | DoS: the browser eats host RAM/CPU. | One daemon per user, `prlimit` memory cap, a tab cap, idle shutdown, and the screencast only while visible. | Heavy pages can still use up to the cap. |
| T10 | A downloaded file or the MCP output dir escapes the home. | `Browser.setDownloadBehavior` → `~/Downloads`. MCP `--output-dir ~/.floq/browser/output`. Without `--allow-unrestricted-file-access`, MCP file access stays in the workspace roots. | None. |

**Residual risks found in review (accepted, not fixed):**

- **L2** The daemon token reaches the MCP child in its argv/env inside the user's sandbox, so other processes of the same uid can read it. Same trust class as T1 (the user's own agents).
- **L7** Screencast frames go to every casting viewer of the user regardless of `targetId`. All viewers are the same user, so this is not a cross-user leak.
- **L8** Downloads are not size-capped and land in `~/Downloads` inside the user's encrypted home (counts against their quota).
- **L10** `FLOQ_BROWSER=0` skips the browser libs but the `browser` build stage still runs when the image is built with BuildKit's default; it only affects build time, not the final image.
- **Session cookies** (expiry -1, and everything imported without an expiry) are session cookies. The daemon now asks Chromium to `Browser.close` and waits up to 5 s so the store is flushed, but Chromium does not persist session cookies across restarts, so they are lost when the daemon stops (idle shutdown, restart). Re-import after a restart if needed.
- **Bookmarks** are stored in `~/.floq/browser/bookmarks.json` but nothing reads them yet.

### A.10 File-by-file plan

**Image**
- `runtime/Dockerfile`: a new `browser` stage plus two layers in the runtime stage, exactly as in §A.12.
- `runtime/image/browser/package.json` + `package-lock.json` (new): the **single version pin** (§A.12.5).
- `runtime/image/floq-browserd.mts` (new), `runtime/image/floq-browser-mcp.mts` (new), both added to the COPY/chmod line next to `floq-vault`.
- `runtime/image/floq.mts`: `floq browser status|version|restart` (§A.12.4), calling the internal routes, plus a help line.

**Runtime**
- `runtime/src/browser.ts` (new): `BrowserService`, the daemon handle (spawned with `ShardDriver.spawnPipe`, `cwd: "."`, env with `HOME`, `PLAYWRIGHT_BROWSERS_PATH`), the JSON-line codec with a 4 MiB line cap, viewers, idle timer, `syncMcp`, and the private-network interceptor flag.
- `runtime/src/browserProtocol.ts` (new): pure validators for UI → daemon messages and the URL scheme rule. Shared by the runtime and, if bundled, the daemon.
- `runtime/src/server.ts`: WS upgrade branch `/v1/browser/stream` inside `handleUpgrade` (line ~1482). REST `GET /v1/browser`, `POST /v1/browser/restart`, `POST /v1/browser/clear-data`. Internal `browser/ensure` and `browser/status` in the `/internal/*` switch next to `display/*` (line ~428).
- `runtime/src/manager.ts` (**coordinate first, see §A.3**): count the daemon as shard activity, call `browser.stop` in `sleepUser` and before `shards.sleep` in `scheduleLock`, and pass the profile into managed settings (B).
- `runtime/src/shard.ts`: in the bwrap argv, `--ro-bind /opt/floq /opt/floq` and `/etc/fonts` (§A.12.2). This is sandbox code, so the security reviewer in task 6 checks it.
- `runtime/src/mcpConfig.ts`: `RESERVED_MCP_NAMES` and the `validateMcpName` refusal. Export `FLOQ_BROWSER_MCP_SPEC`.
- `runtime/src/settings.ts`: `agentBrowser` in public settings, patch and `RuntimeProfile`, plus a DB column through `db.ts migrateApp` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS agent_browser boolean`).
- `runtime/src/capabilities.ts`: report `browser`.
- `runtime/src/config.ts`: the `FLOQ_AGENT_BROWSER`, `FLOQ_BROWSER_IDLE_MS`, `FLOQ_BROWSER_MEM_MB` and `FLOQ_BROWSER_ALLOW_PRIVATE` env vars.
- `runtime/src/wiredContext.ts`: the one-line browser hint when it is enabled.

**Frontend**
- `src/components/canvas/browser-node.tsx` (new), `src/lib/runtime/browser-stream.ts` (new), `src/lib/runtime/client.ts` (URL and REST methods), `src/lib/runtime/types.ts` (types), `src/components/canvas/agent-canvas-page.tsx` (node type and hook), `src/components/canvas/canvas-menu.tsx` ("Open browser"), `src/components/canvas/canvas-kbd.tsx` (suppress while the browser is focused), `src/components/settings/agents-section.tsx` (the Browser group).

**Docs**
- `docs/runtime-agents.md` (agent-facing usage), `SECURITY.md` (T4–T7), and a release note.

### A.11 Tests

- `runtime/test/browserProtocol.test.mts`: validator fuzzing (bad types, out-of-range coordinates, oversize text, every forbidden URL scheme, IDN/whitespace URL tricks).
- `runtime/test/browserDaemon.test.mts`: run `floq-browserd` with the real pinned Chromium under bwrap with a throwaway HOME, never the real home (the pattern in claudeManagedPlugins tests). Checks:
  - a WS upgrade without a token, with a wrong token, or with an `Origin` header gets 401/403;
  - a correct token lets Playwright `connectOverCDP` work;
  - two concurrent clients both work;
  - Chromium has no listening TCP socket (`/proc/net/tcp` diff);
  - the profile persists a cookie across a restart.
- `runtime/test/browserService.test.mts`: with a fake daemon over pipes, check the idle timer, that stop runs before shard sleep, backpressure frame dropping, the viewer count, and a crash moving to `stopped` and then a restart.
- `runtime/test/mcpConfig.test.mts` (extend): `floq-browser` is reserved; the sync is idempotent; a user-edited entry is reported and not overwritten.
- `runtime/test/browserServer.test.mts`: the WS route rejects a bad token or Origin; user A's socket can never attach to user B's daemon.
- `e2e/browser-node.spec.ts` (Playwright, runtime mocked as in other e2e specs): the node renders frames from a mocked stream, clicks map to the right coordinates at two zoom levels, typing sends `input.key`/`input.text`, the URL bar sends `nav.go`, canvas shortcuts do not fire while it is focused, and the disabled and unavailable states appear.
- Manual smoke check in the real container: an agent runs `browser_navigate` to a page, the user sees it on the node, the user logs in to a test site, and the agent's next snapshot shows the logged-in state.

---

## B. claude.ai connectors

### B.1 Findings (verified against Claude Code 2.1.319 in the image and 2.1.322 installed here)

Claude Code fetches connectors in its `claudeai-mcp` loader (`GET {BASE_API_URL}/v1/mcp_servers?limit=1000&include_additional_installs=true`, `anthropic-beta: mcp-servers-2025-12-04`). Traffic goes to `mcp-proxy.anthropic.com/v1/mcp/{server_id}`. The loader skips connectors when any of these holds:

1. `ENABLE_CLAUDEAI_MCP_SERVERS` is set to `0|false|no|off`;
2. any settings source sets `disableClaudeAiConnectors: true` (any source that says true wins);
3. safe mode;
4. a third-party provider (Bedrock/Vertex);
5. API-key auth takes precedence (`ANTHROPIC_API_KEY` or another auth source is set);
6. the token lacks the `user:mcp_servers` scope;
7. `--strict-mcp-config` / `--bare`;
8. a managed MCP configuration (`managed-mcp.json` / `allowManagedMcpServersOnly`).

Floq status: Floq writes `claudeAiOauth` into `~/.claude/.credentials.json`, with `CLAUDE_SCOPES` (claudeOauth.ts) including `user:mcp_servers` since the initial commit. Launch argv has no strict/bare flag. The image's managed settings set only a permissions deny and a hook. `forcedSessionEnv` does not touch the flag. Cross-check: this Floq agent session itself shows `claude.ai Claude Docs` and `claude.ai Higgsfield` MCP servers.

**Conclusion: connectors already load natively. No env or setting is needed to turn them on.** The things that silently turn them off for a user are (5) an `ANTHROPIC_API_KEY` in their vault/env, and (6) a token without the scope (an older manual or long-lived token).

### B.2 Design

- **Toggle**: per-user `claudeAiConnectors: boolean`, default `true`, in `settings.ts` (the same three places plus a DB column). When it is **off**, `buildClaudeManagedSettings` (claudeManagedPlugins.ts:43) gets an option and writes `disableClaudeAiConnectors: true` into the per-user managed settings that are bound read-only at `/etc/claude-code`. That is managed, so an agent cannot re-enable it in-session; it applies at the next session start. When it is **on**, Floq writes nothing (Claude Code's default). Do not use `ENABLE_CLAUDEAI_MCP_SERVERS`, because a user env value could contradict it. Pass it through `manager.launch` at line ~1521 (`promoteUserPlugins({... base})`). **This is a manager.ts touchpoint: coordinate, re-read first, keep it small.**
- **Connector list** (read-only): `GET /v1/claude/connectors` in the runtime. It uses the user's stored Claude OAuth access token, refreshed by the existing credential code, and calls the same `/v1/mcp_servers` endpoint with the headers above, with a 10 s timeout, cached 5 min per user. It returns only `{name, displayName, url host, connected}`. It never returns tokens, and upstream error bodies are never echoed. This endpoint is undocumented, so the UI treats any failure as "couldn't load list" and still shows the toggle and a "Manage at claude.ai → Settings → Connectors" link (opened with the opener plugin).
- **Diagnostics** shown above the list:
  - "Claude is signed in with an API key: connectors are off" when `ANTHROPIC_API_KEY` is in the user's vault/env allowlist;
  - "Sign in to Claude again to grant connector access" when the stored `scopes` lack `user:mcp_servers` (with a button reusing `claude-oauth-dialog.tsx`);
  - "Codex sessions do not use claude.ai connectors."
- **UI**: Settings > Agents (or Accounts, next to the Claude account), a "claude.ai connectors" group with the toggle, diagnostics and the list. A restart-required hint: "Applies to new or restarted Claude sessions."
- **Per-connector off**: phase 2. Candidate: managed `deniedMcpServers` keyed by the connector's server name in Claude Code (verify the exact name form, e.g. `claude.ai <Name>`, against the binary before building it).

### B.3 Threat model

| # | Threat | Note |
|---|---|---|
| C1 | Agents act through connectors (mail, drive, …) with the user's claude.ai grants. | This is the stated goal. The toggle off is managed (agents cannot undo it in-session). Connector OAuth tokens stay at Anthropic and never enter the sandbox. |
| C2 | The runtime leaks the user's Claude token through the list endpoint. | It returns allowlisted fields only. Upstream bodies are dropped. Log only the status code. |
| C3 | Cross-org data flow (`CLAUDE_CODE_I_ACCEPT_CROSS_ORG_DATA_RISK`). | Floq never sets it. Add it to the forced-env denylist so a vault entry cannot set it. |

### B.4 Files

`runtime/src/settings.ts`, `runtime/src/db.ts` (column), `runtime/src/claudeManagedPlugins.ts` (option in `buildClaudeManagedSettings`), `runtime/src/manager.ts` (one-line pass-through, coordinated), `runtime/src/providers.ts` (deny `CLAUDE_CODE_I_ACCEPT_CROSS_ORG_DATA_RISK` and `ENABLE_CLAUDEAI_MCP_SERVERS` in user env only if they are not already covered by the CLAUDE* rule; `ENABLE_*` is not), `runtime/src/claudeConnectors.ts` (new: fetch, cache, diagnostics), `runtime/src/server.ts` (route), `src/lib/runtime/client.ts` + `types.ts`, `src/components/settings/agents-section.tsx` (group).

### B.5 Tests

- `runtime/test/claudeManagedPlugins.test.mts` (extend): the toggle off writes `disableClaudeAiConnectors: true`, the toggle on omits the key, and the base keys are kept.
- `runtime/test/claudeConnectors.test.mts`: with mocked fetch, check the headers sent, that only allowlisted fields are returned, a 401 becoming the `needs_signin` diagnostic, a missing scope becoming the diagnostic, the API-key diagnostic, that the token never appears in errors or logs, and the cache.
- Manual check in the container: with the toggle off, a restarted Claude session's `/mcp` lists no `claude.ai …` servers; with it on, they come back.

---

## Implementer tasks

| # | Task | Files | Depends on | Size |
|---|---|---|---|---|
| 1 | **Image + daemon**: §A.12 packaging (browser stage, minimal libs + fonts, `/opt/floq/browsers`, single pin, build checks, **measured image delta in the PR**); `floq browser status|version|restart`; `floq-browserd.mts` (pipe CDP, authenticated WS multiplexer, control channel, sandbox probe, flags); `floq-browser-mcp.mts`; `browserDaemon.test.mts` | runtime/Dockerfile, runtime/image/*, runtime/src/shard.ts (2 ro binds) | none | L |
| 2 | **Runtime service + routes**: `browser.ts`, `browserProtocol.ts`, server routes (WS, REST, internal), config, capabilities, settings `agentBrowser`, MCP reserve + sync, wired-context hint; tests 3–5 of §A.11 | runtime/src/*, runtime/test/* | 1 (protocol contract only; can start against a fake daemon) | L |
| 3 | **manager.ts hooks** (small, coordinate with orchestrator 23d4fea3 first): browser as shard activity, stop before sleep; claudeAiConnectors pass-through | runtime/src/manager.ts | 2, 5 | S |
| 4 | **Canvas Browser node + Settings Browser group**; e2e spec | src/components/canvas/*, src/lib/runtime/*, src/components/settings/agents-section.tsx, e2e/browser-node.spec.ts | 2 (message contract §A.5; can mock) | M |
| 5 | **claude.ai connectors (B)**: settings column, managed-settings option, `claudeConnectors.ts`, route, env denylist, Settings group, tests | per §B.4 | none | M |
| 6 | **Docs + security review**: runtime-agents.md (usage + the §A.12.5 bump procedure), SECURITY.md, release note; review tasks 1–2 against §A.9 (T1, T2, T6 in particular) | docs/* | 1, 2 | S |

Tasks 1, 4 and 5 can start in parallel right away (4 against a mocked stream). Task 3 comes last and stays small.

No push, release or deploy is part of these tasks.


---

## A.12 Chromium packaging (user addendum: "add chromium in a nice way")

### A.12.1 Source: Playwright's pinned `chromium-headless-shell`

**Choice:** `playwright-core install --only-shell chromium`, run with the playwright-core that `@playwright/mcp@0.0.84` itself depends on. This gives `chromium_headless_shell-1252` (Chromium 157.0.8103.15).

Why:
- **Reproducible and version-locked to the MCP.** The revision comes from playwright-core's `browsers.json`, which is fixed by the npm lockfile. The download comes from Playwright's CDN over HTTPS; the zip is not pinned by a sha256 in the Dockerfile (only the revision is), so the CDN and TLS are trusted for that artifact. There can be no MCP/browser protocol drift.
- **Debian's `chromium` package was rejected.** bookworm-security moves it under us (no exact pin survives `apt-get update` after the old version leaves the archive). It pulls in GTK and X11 client stacks, and its version is unrelated to the MCP's playwright-core.
- **Full Playwright `chromium` (headed-capable) was rejected.** It is larger and needs GTK. `--with-deps` also installs **xvfb** and a broad font set. We have no use for a headed browser: the UI is a CDP screencast.
- **Capability check:** the headless shell supports everything we use: `--remote-debugging-pipe`, a persistent `--user-data-dir`, `Page.startScreencast`, `Input.*`, `Fetch.*`, downloads and Playwright `connectOverCDP`. It lacks extensions and headed-only features, which we do not need.

### A.12.2 Dockerfile layout (cache-friendly)

```dockerfile
# ---- browser: pinned Playwright MCP + Chromium headless shell (independent of the app build) ----
FROM node:22-bookworm-slim AS browser
WORKDIR /opt/floq/playwright-mcp
COPY image/browser/package.json image/browser/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/floq/browsers
RUN node node_modules/playwright-core/cli.js install --only-shell chromium \
    && rm -rf /opt/floq/browsers/ffmpeg-* \
    && node -e 'const b=require("playwright-core/browsers.json").browsers.find(x=>x.name==="chromium-headless-shell"||x.name==="chromium");const m=require("@playwright/mcp/package.json");require("fs").writeFileSync("/opt/floq/browsers/VERSION.json",JSON.stringify({chromium:b.browserVersion,revision:b.revision,playwrightMcp:m.version}))'

# ---- runtime stage (existing) ----
FROM node:22-bookworm-slim AS runtime
ARG FLOQ_BROWSER=1
# Layer 1: only the shared libraries chrome-headless-shell links against (ldd) + fontconfig + fonts. No X server, no GTK.
RUN if [ "$FLOQ_BROWSER" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 libgbm1 libasound2 \
      fontconfig fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*; fi
# ... existing layers (claude-code/codex, gh, floq CLI) unchanged ...
# Layer 2: copied last-ish so app/CLI changes don't invalidate it, and a browser bump doesn't rebuild apt layers.
COPY --from=browser --chown=root:root /opt/floq /opt/floq
RUN [ "$FLOQ_BROWSER" = 1 ] || rm -rf /opt/floq/browsers /opt/floq/playwright-mcp; \
    [ ! -d /opt/floq ] || chmod -R a+rX,go-w /opt/floq
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/floq/browsers
```

Notes:
- The `browser` stage depends only on `image/browser/package*.json`, so it is cached until the pin changes. The apt layer is cached until the lib list changes. Source edits never re-download Chromium.
- The libs list is exactly what `ldd chrome-headless-shell` reports as missing on bookworm-slim (measured: libglib-2.0, libgobject, libgio, libnspr4, libnss3, libnssutil3, libatk, libatk-bridge, libatspi, libdbus, libX11, libXcomposite, libXdamage, libXext, libXfixes, libXrandr, libgbm, libxcb, libxkbcommon, libasound) plus fontconfig. The implementer re-runs `ldd … | grep 'not found'` in the built image and fails the build if anything is missing (§A.12.6).
- **Path:** `/opt/floq/browsers` (`PLAYWRIGHT_BROWSERS_PATH`), owned by root, `a+rX` so every sandbox uid can read and execute it. **`/opt` is not bound into the sandbox today** (`shard.ts` ~L471 binds `/usr` and a fixed `/etc` list). The implementer must add `--ro-bind /opt/floq /opt/floq` (when it exists) and **`/etc/fonts`** to the `/etc` allowlist at `shard.ts` ~L480. Without `/etc/fonts`, fontconfig finds no fonts and pages render as tofu. Both are read-only, so other users' data is never exposed.
- **No downloads per user or at runtime:** the daemon sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and passes `--executable-path` explicitly (it does not search). `floq-browser-mcp` runs the MCP with `--executable-path` too, even though it connects over CDP, so it can never try a download.
- `FLOQ_BROWSER=0` gives the old image: an empty `/opt/floq`, and `capabilities.browser = "missing"`.

### A.12.3 Image size

Measured on this host (Debian 12 package metadata; no Docker daemon here, so these are not a built-image diff):

| Part | Size (installed) |
|---|---|
| `chromium_headless_shell-1252` | 280 MB |
| `@playwright/mcp@0.0.84` + playwright-core | 19 MB |
| Shared libs + fontconfig (upper bound, before dedup with libs already in the image) | ~14 MB |
| fonts-liberation + fonts-noto-color-emoji | ~13 MB |
| fonts-noto-cjk | 91 MB |
| **Total, uncompressed upper bound** | **~417 MB** (about 150 MB compressed in the registry, estimated) |

- ffmpeg (5 MB) is deleted: there is no video recording.
- If 91 MB for CJK is too much, `fonts-wqy-zenhei` (~17 MB, lower quality) is the fallback; we keep Noto by default because users read CJK sites through the node.
- **Implementer must report the real delta:** `docker build --build-arg FLOQ_BROWSER=0 -t floq-rt:nobrowser runtime && docker build -t floq-rt:browser runtime && docker image inspect -f '{{.Size}}' floq-rt:nobrowser floq-rt:browser`. Put both numbers in the PR description and in the release note.

### A.12.4 Health check: `floq browser`

The in-sandbox CLI (`runtime/image/floq.mts`) and the runtime (`GET /v1/browser`) share this output:

```
$ floq browser status
browser: running (pid 4123, up 12m, 2 agent connections, 3 tabs)
chromium: 157.0.8103.15 (headless shell r1252), playwright-mcp 0.0.84
profile: ~/.floq/browser/profile (38 MB)
sandbox: chromium sandbox on            # or: "off (no nested user namespaces in bwrap; see docs/design/agent-browser.md §A.4)"
$ floq browser version     # prints VERSION.json only; works with the browser stopped
$ floq browser restart
```

`status` exits 0 when running, 3 when stopped, 4 when disabled or missing, so scripts and agents can check it. The version comes from `/opt/floq/browsers/VERSION.json`, written at build time. `floq-browserd` also cross-checks it against CDP `Browser.getVersion` at start and logs a mismatch.

### A.12.5 One place to bump

`runtime/image/browser/package.json` is the single source of truth:

```json
{ "private": true, "name": "floq-browser", "dependencies": { "@playwright/mcp": "0.0.84" } }
```

The Chromium revision follows from the playwright-core in the committed lockfile. No other file names a version: `VERSION.json` and the Settings display are derived. Bump procedure (to be documented in `docs/runtime-agents.md` under "Agent browser"):
1. Pick a `@playwright/mcp` release that is at least 2 weeks old.
2. Set it in `runtime/image/browser/package.json` and run `npm install --package-lock-only` in that folder.
3. Build both image variants and run the §A.12.6 checks plus `browserDaemon.test.mts`.
4. Record the new Chromium version and the image delta in the release note.

### A.12.6 Sandbox, profile and build checks

- **Launched only in the user's sandbox:** the runtime never executes `/opt/floq/browsers/*` on the host. The only launcher is `floq-browserd`, spawned through `ShardDriver.spawnPipe` (bwrap, per-user uid, netns when enabled). A test asserts that BrowserService refuses to start without a shard handle.
- **Chromium's sandbox (try first, avoid `--no-sandbox`):** at start, `floq-browserd` runs `chrome-headless-shell --version` once, and then a probe launch *with* the sandbox. Chromium's sandbox uses user namespaces when no setuid helper exists. If bwrap allows nested userns (bwrap is not started with `--disable-userns`, and the kernel `user.max_user_namespaces` > 0), the probe succeeds and we run with the sandbox. Otherwise we fall back to `--no-sandbox` and log the reason (`browser.chromium_sandbox_off {reason}`). This shows in `floq browser status` and Settings. Today's bwrap argv (`shard.ts` ~L467) uses `--unshare-pid/ipc/uts/cgroup-try` and neither `--unshare-user` nor `--disable-userns`, so the probe succeeds whenever the host kernel and the container's seccomp profile allow unprivileged `CLONE_NEWUSER`. Docker's default seccomp profile usually denies it, so expect the `--no-sandbox` fallback on stock Docker. **Implementer action:** test both paths, and document the host setting that turns the Chromium sandbox on (a seccomp profile that allows userns, or `kernel.unprivileged_userns_clone=1`) in docs/runtime-agents.md. Do not add a setuid `chrome-sandbox`: a setuid binary inside the sandbox is a worse trade than relying on bwrap.
- **Profile:** `~/.floq/browser/profile` in the gocryptfs home, created 0700 by the daemon. Clear browser data removes only that directory.
- **Build checks** (a `RUN` at the end of the runtime stage when `FLOQ_BROWSER=1`):
  - `ldd /opt/floq/browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | grep -q 'not found' && exit 1`;
  - `fc-list | grep -qi 'Noto Color Emoji'` and `fc-list | grep -qi 'Noto Sans CJK'`;
  - `test -s /opt/floq/browsers/VERSION.json`.

---

## A.13 Cookie and data import (user requirement, task 7)

Binding requirements, from the lead:

1. User-initiated import only, from files the user exports themselves: cookies (Netscape cookies.txt and the common JSON cookie-export format from browser extensions), bookmarks (HTML), optionally localStorage per origin if the format carries it; a Chromium profile folder/zip only if it can be done cleanly (no foreign OS-encrypted blobs). Never read the user's local Chrome/Edge/Firefox stores from the desktop app.
2. UI (Browser node and Settings > Browser): "Import cookies & data" with a preview listing domains and cookie counts, per-domain checkboxes, a clear warning that agents will act as the user on those sites, then import into the per-user profile (CDP Network.setCookies / Storage APIs) in the encrypted home.
3. Manage: list imported domains, remove per domain, "Clear all browser data".
4. Security: files parsed on the runtime, never logged, size-limited, uploaded over the authenticated channel only, deleted after import; cookies never leave the user's sandbox and are unreadable by other users or their agents. Tests: parser edge cases (expired, httpOnly, sameSite, host-only vs domain cookies, malformed lines) and per-user isolation. Also document in docs/SECURITY.md.

Task 7 (after task 2): design details (parsers, preview/commit API, import via CDP, manage/clear routes, UI in Browser node and Settings, tests for parser edge cases and per-user isolation) are written by the implementer into this section, then implemented. Also document in docs/SECURITY.md.

### A.13.1 Design (implementer, task 7)

**Formats** (`runtime/src/browserImportParse.ts`, pure, no I/O, auto-detected from content):
- *Netscape cookies.txt*: 7 tab-separated fields `domain, includeSubdomains, path, secure, expires, name, value`; a `#HttpOnly_` prefix marks httpOnly; other `#` lines and blanks are skipped. `includeSubdomains=TRUE` makes a **domain cookie** (`.example.com`); `FALSE` makes a **host-only** cookie (`example.com`, no dot). `expires=0` is a session cookie. The format carries no SameSite.
- *JSON export* (Cookie-Editor, EditThisCookie, Playwright `storageState`): an array of cookies, or `{cookies:[…]}`. Fields: `name, value, domain, hostOnly, path, secure, httpOnly, session, expirationDate|expires` (seconds), `sameSite` (`no_restriction|None|lax|strict|unspecified`). Host-only is explicit `hostOnly`, else inferred from the leading dot. localStorage in `origins` is **not imported** (it cannot be set without a page at that origin; Network.setCookies only covers cookies). The preview says so.
- *Bookmarks HTML* (Netscape bookmark file): `<A HREF>` entries with `<H3>` folder paths; only `http:`/`https:` URLs; stored as `~/.floq/browser/bookmarks.json` (0600) in the user's home.
- A Chromium profile folder/zip is **not supported**: its cookie DB is encrypted with an OS-keyring key that does not exist here, and copying foreign blobs is not clean.

**Rules.** Expired cookies are dropped and counted. Malformed lines/entries are dropped and counted, never echoed. `__Host-` needs secure + path `/` + host-only, `__Secure-` needs secure; `SameSite=None` without secure drops the SameSite. Limits: file 5 MiB, 5000 cookies, name/value 4096 chars, domain 253, 20000 bookmarks. Upload is a JSON body `{name, content}` (the text is read by the user's browser `File.text()`; same authenticated channel as every other call).

**API** (all about the caller's own browser; user from the bearer token, no user id in any route):
- `POST /v1/browser/import/preview {content}` → parses, keeps ONLY the parsed result in server memory (TTL 10 min, max 3 per user, keyed by user + random id; the raw upload is never stored, written to disk or logged) → `{importId, format, cookies:{total, domains:[{domain,count}], expired, malformed}, bookmarks:{count}}`.
- `POST /v1/browser/import/commit {importId, domains[], bookmarks}` → drops the stored upload (single use), starts the browser if needed, and applies the selected cookies through CDP (`Network.setCookies` via playwright-core `connectOverCDP`, `context.addCookies`) in a helper `node` process **inside the user's sandbox**, fed over stdin. A batch failure falls back to one-by-one and counts failures. → `{imported, failed, bookmarks}`.
- `GET /v1/browser/data` → `{domains:[{domain,count}], bookmarks:n}`: names and counts only, **never values**.
- `POST /v1/browser/data/remove {domain}` → clears that domain's cookies (`context.clearCookies`). `POST /v1/browser/clear-data` (existing) clears everything.
- Cookies exist only in the sandbox helper's stdin, the user's browser profile and the in-memory preview; the runtime logs counts and status codes only.

**UI.** `src/components/canvas/browser-import-dialog.tsx`: pick file → preview table with a checkbox per domain (all on), a bookmarks checkbox, the warning "Agents will act as you on these sites", Import. Entry points: a header button on the Browser node and Settings > Agents > Browser. Settings also lists imported domains with a Remove button per domain. Client: `browserImportPreview/Commit`, `browserData`, `browserRemoveDomain`.

**Tests.** `runtime/test/browserImport.test.mts` (parsers: expired, httpOnly, sameSite, host-only vs domain, malformed, prefixes, limits, bookmarks; service: preview/commit with a fake sandbox, single use, per-user isolation, no content in logs) and `e2e/browser-import.spec.ts`.

## Contract notes from task 4 (canvas UI, implemented)

- app->runtime `input.mouse` / `input.key` carry the CDP event type in field `kind` (not `type`).
- Clear-data REST sends `{confirm:'clear'}`.
- The app never sends `frame.ack`; the runtime acks.
- `GET /v1/browser` must return `{state, agents, tabs, version:{chromium,revision,playwrightMcp}, profile}`.
- The node auto-opens when `GET /v1/browser` reports `agents>0`, once per project (localStorage).
- Wire types live in `src/lib/runtime/browser-types.ts`; client methods: browserStreamUrl/browserStatus/browserRestart/browserClearData.

## Contract notes from task 1 (image + daemon, implemented)

TASK 1 DONE (Image + daemon, A.12). Nothing committed or pushed; manager.ts untouched. FILES (new): runtime/image/floq-browserd.mts (entry), runtime/image/floq-browserd-core.mts (validators, RFC6455 server, CdpMux, T6 host check; installed next to it like floq-args.mjs), runtime/image/floq-browser-mcp.mts, runtime/image/browser/package.json + package-lock.json (single pin @playwright/mcp 0.0.84 -> playwright-core 1.65.0-alpha-2026-10-30, chromium-headless-shell r1252 = 157.0.8103.15, verified with --dry-run), runtime/test/browserDaemon.test.mts, runtime/test/fixtures/fakeChromium.mjs. FILES (edited): runtime/Dockerfile (browser stage, ARG FLOQ_BROWSER, libs layer, /opt/floq layer, build checks, COPY/chmod of the 3 new files), runtime/src/shard.ts (--ro-bind /opt/floq via a 0755 /opt dir, --ro-bind /etc/fonts, both only if present), runtime/image/floq.mts + floq-args.mts (floq browser status|version|restart, formatBrowserStatus; exit 0/3/4). TESTS: tsc (both tsconfigs) clean. browserDaemon.test.mts 22/22 pass, incl. real Chromium 158 + real playwright-core + real @playwright/mcp 0.0.84 (I unpacked the runtime libs rootless into scratch with LD_LIBRARY_PATH; without a runnable chromium those 3 tests SKIP and 19 pass). Covered: validator fuzz and URL-scheme tricks, token/Origin/Host/path gate (401/403/404), loopback-only listener, 0600/0700 modes, sandbox fallback, stale SingletonLock, two agents on one pipe with isolated sessions, tab cap, control channel, T6 Fetch interceptor (ERR_ACCESS_DENIED), cookie persists across daemon restart, MCP drives the shared browser through floq-browser-mcp. floqToolkit.test fails here only because node-pty has no native binding in this env (unrelated). NOT DONE: no docker here, so image build, ldd/fc-list build checks and the image-size delta (A.12.3) are unmeasured; run the docker build commands from A.12.3. bwrap/real-userns path of the sandbox probe not exercised (here Chromium fell back to --no-sandbox, as expected). CONTRACT NOTES for task 2/3/4: - Control JSON lines: mouse/key events use field `kind` (mousePressed|mouseReleased|mouseMoved; keyDown|keyUp|rawKeyDown|char) because `type` names the message (matches src/lib/runtime/browser-types.ts). Coordinates are validated against the latest frame w/h (default 1280x800). Errors: bad_message, bad_url, bad_json, line_too_long, no_target, failed, start_failed. - `ready` also carries {pid, chromium, sandbox:"on"|"off", sandboxReason?}. Daemon env knobs: HOME, PLAYWRIGHT_BROWSERS_PATH (default /opt/floq/browsers), FLOQ_BROWSER_BLOCK_PRIVATE=1 (T6 interceptor: runtime should set it when no netns and not FLOQ_BROWSER_ALLOW_PRIVATE), FLOQ_BROWSER_MEM_MB (optional prlimit --as, OFF unless passed), FLOQ_BROWSER_NO_SANDBOX=0|1 (skip probe), FLOQ_BROWSER_EXECUTABLE (test override). Spawn: file "node" or /usr/local/bin/floq-browserd, cwd ".". - floq-browser-mcp POSTs {FLOQ_API_URL}/internal/browser/ensure and expects {wsEndpoint:"ws://127.0.0.1:PORT/devtools/browser", token} or {error:{code:"disabled"|..., message}}. floq browser CLI calls internal browser/status -> {state,pid,uptimeSec,agents,tabs,version,profile,profileBytes,sandbox} and browser/restart -> {state}; status must answer 200 with state disabled/unavailable (call() exits on non-2xx). - Spec deviation: MCP path is /opt/floq/playwright-mcp/node_modules/@playwright/mcp/cli.js (A.12.2), not /usr/local/lib/floq as in the A.2 diagram. Doc's Dockerfile VERSION.json snippet does not work (playwright-core/browsers.json is not exported); I read the files by path. Risk: RLIMIT_AS 2048 MB (A.3) will likely crash Chromium's large reservations, so I made it opt-in; test it before the runtime enables it. - Pinned MCP 0.0.84 returns browser_navigate snapshots as a file link under ~/.floq/browser/output; browser_snapshot returns inline.


Not done in task 1: docker build, ldd/fc-list checks and image-size delta (A.12.3) are unmeasured (no docker on this host).

## A.14 One page per Browser node, linked agents, pointer input (v1.0.8)

Supersedes the tab strip of §A.8 and the tab messages of §A.5.

- **One node = one page.** Any number of Browser nodes per canvas (menu "New browser here", the node's "New browser" button). The node id is opaque (`browser:<id>`, stored locally per project in `floq:browser-nodes:<project>`; the old single-node record migrates to `browser:main`). The stream URL carries it (`/v1/browser/stream?node=<id>`); the runtime asks the daemon for the node's page (`page.open`, idempotent: the first node adopts the initial blank tab) and answers `{type:"page", targetId}`. A viewer only ever acts on its own page: the runtime fills in `targetId`. Closing the node sends `page.close` (page destroyed, links dropped). All nodes share the one per-user profile (cookies and logins are shared); isolating per node is a Chromium profile per node and was not done.
- **Wires.** A Browser node has the agent side-strip handles, uses the standard `wire` edge (`bwire:<node>:<session>`), link mode, context menus and Delete. Rows live in `browser_links(user_id, node_id, session_id)` (cascade with the session, `BrowserLinks`), routes `GET/POST /v1/browser/links`, `DELETE /v1/browser/links/:node[/:session]`. The linked browser is listed in the agent's wired context (`browser` kind). An agent drives one node at a time (linking elsewhere replaces the wire); many agents may share a node.
- **Routing.** `/internal/browser/ensure` returns the endpoint with `?agent=<session id>`. The daemon scopes that CDP client: a linked client sees exactly its node's page (targets, discovery, attach, close are filtered; `Target.createTarget` is refused), re-linking or unlinking is applied live to the open connection (`agent.scope`, detach/attach events), unlinked agents never see node pages. Stored links are re-applied when a daemon starts. Several agents on one node interleave commands on the one page (last action wins); there is no lock.
- **Pointer input.** `input.mouse` carries `buttons` and `modifiers`, `input.wheel` carries `modifiers`; all go to `Input.dispatchMouseEvent`. The daemon reports the page cursor (`cursor`, probed with `elementFromPoint` at most every 80 ms). `viewport {width,height,dpr}` becomes `Emulation.setDeviceMetricsOverride` so the page follows the node size.
- **Human checks.** No stealth, UA changes or solvers. The user completes a challenge by hand in the live view; the profile keeps the clearance cookie. The node shows a hint bar when the title or URL looks like a challenge.
  Finding (Chromium 157 headless shell r1252, unmodified, 2026-11-13): nowsecure.nl, cloudflare.com and discord.com load normally; g2.com answers `403` from Cloudflare with an empty body (no interactive challenge), so a hard-blocking site cannot be completed by hand. The UA contains `HeadlessChrome` and `navigator.webdriver` is true. Option for the lead (not implemented): run the full Chromium build in new headless mode with its normal UA.
