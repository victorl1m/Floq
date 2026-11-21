# Agent browser egress through the user's computer

Status: implemented in v1.0.10 (off by default, desktop app only). Wire protocol: `docs/design/browser-user-egress-protocol.md`. Companion to `docs/design/agent-browser.md` (§A.2 architecture, §A.9 threat model).

**Goal.** When the user turns it on, every network connection the agent browser (Chromium inside the user's sandbox on the VPS) makes leaves the internet from the **user's own computer**, through the Floq desktop app. Sites see the user's residential IP and location, not the VPS.

**Non-goal.** Making a headless browser look human. See §6.

---

## 1. Shape

```
 Chromium (user sandbox, VPS)
   │ --proxy-server=socks5://127.0.0.1:<eph>     (hostnames, never resolved locally)
   ▼
 floq-browserd: SOCKS5 endpoint ("egress listener")
   │ peer check: socket uid == sandbox uid AND socket inode held by the Chromium process tree
   │ one binary mux channel over a new pipe (fd 3) to the runtime
   ▼
 runtime: BrowserEgress (per user)      ── a dumb, authenticated frame relay; it never opens target sockets
   │ WS /v1/browser/egress  (desktop dials OUT: works behind NAT; bearer = the app's session token)
   ▼
 Floq desktop app (src-tauri/src/egress.rs)
   │ guard: allowed ports, no private/loopback/link-local (after DNS), caps
   │ resolves DNS on the user's machine, opens the real TCP connection
   ▼
 internet (source IP = user's IP)
```

Why this split:

- **The proxy listener lives in the daemon, inside the sandbox**, not in the runtime. Inside the sandbox it can prove the peer is *this* user's Chromium (§3.1). A listener in the runtime would sit in the host netns where, with `FLOQ_NETNS` on, all traffic arrives via pasta and the uid is lost.
- **The desktop dials the runtime** (like `/v1/events`), never the reverse. The user's machine opens no listening port at all. That alone kills the "open proxy on the user's machine" class of bugs.
- **The runtime is a relay**, keyed by authenticated user id on both sides. It never connects to a target, so turning the feature on cannot make the VPS an SSRF source.
- It reuses the prior art of port forwarding (`src-tauri/src/port_forward.rs`, `runtime/src/ports.ts` `pipeTunnel`) for the WS, auth and backpressure patterns, in the reverse direction.

## 2. Protocol

### 2.1 Chromium → daemon: SOCKS5, no auth, domain names

- **SOCKS5, not HTTP CONNECT.** Every connection, https, http, ws, wss, h2, is one `CONNECT host:port`. The daemon never parses HTTP, never sees plaintext HTTP framing problems (absolute-form, keep-alive across hosts), and plain `http://` needs no special path. Chromium's SOCKS5 client sends the **hostname** (ATYP 0x03), so DNS happens on the far side. SOCKS4 would resolve locally, so never use it.
- SOCKS5 in Chromium has no auth. That's fine: §3.1 authenticates the peer socket instead of a password, which is stronger (a leaked password would work from any process).
- Only `CMD=CONNECT` (0x01). `BIND` and `UDP ASSOCIATE` are refused with reply 0x07. ATYP 0x01/0x04 (IP literals) are accepted and handed to the desktop guard like names.
- Reply codes map from the desktop's result: refused by guard → 0x02 (not allowed), DNS failure → 0x04 (host unreachable), TCP refused → 0x05, timeout → 0x06, egress offline → 0x01. Chromium shows `ERR_SOCKS_CONNECTION_FAILED` / `ERR_PROXY_CONNECTION_FAILED`. The Browser node maps these to the message in §4.3.

### 2.2 Chromium flags (daemon, only when egress is on)

| Flag | Why |
|---|---|
| `--proxy-server=socks5://127.0.0.1:<port>` | All network-service traffic, including service workers, workers, WebSocket and h2, goes through the proxy. |
| `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost` | Chromium's documented SOCKS hardening: any local DNS lookup fails, so nothing (prefetch, a code path we missed) can resolve via the VPS resolver. `localhost` is excluded as well: verified with the real Chromium that without it the name maps to NOTFOUND (`ERR_NAME_NOT_RESOLVED`) while `127.0.0.1` works, which broke `localhost:3000`. |
| `--disable-quic` | QUIC is UDP and cannot ride SOCKS5 in Chromium. Make it explicit so no Alt-Svc upgrade ever tries UDP direct. WebTransport goes with it. |
| `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | WebRTC may not send UDP outside the proxy, and ICE never exposes the VPS address. WebRTC media then fails or uses TURN/TCP through the proxy. Accepted. |
| `--proxy-bypass-list=<-loopback>` **not set** | Loopback keeps bypassing the proxy (Chromium default), so `localhost:3000` and `127.0.0.1:3000` still reach the agent's dev server in the sandbox (needs the `EXCLUDE localhost` rule above). A page on the internet reaching sandbox loopback is the existing T6, handled as today. |
| `--dns-prefetch-disable` | Belt and braces with the resolver rule. |

Already present and still relevant: `--disable-background-networking`, `--disable-component-update`, `--disable-sync`. No UA, `navigator.webdriver` or fingerprint flags are touched (§6).

**Changing the setting restarts Chromium.** Proxy flags are launch-time. The runtime restarts the daemon (see the protocol doc, "Route switch"), which closes the browser cleanly (the existing 5 s `Browser.close` flush path), and relaunches with or without the flags. Tabs restore from the profile session. The UI says "Restarting browser…".

The **T6 Fetch interceptor** (`shouldBlockHost`) resolves hostnames with `dns.lookup` *on the VPS*. In egress mode that is a DNS leak and a wrong answer anyway, since the desktop resolves. With egress on, the interceptor checks literal IPs and `localhost` names only and leaves name resolution to the desktop guard (§3.2), which is the real boundary for proxied traffic.

### 2.3 Daemon ↔ runtime: binary mux on fd 3

- `ShardDriver.spawnPipe` gains an optional `extraPipe: true` → `stdio: [stdin, stdout, stderr, "pipe"]` (bwrap passes fds through, since `--die-with-parent` doesn't touch them). This must not share the JSON-lines control pipe: screencast frames would add head-of-line latency, and base64 would add a third more bytes.
- Same frame format end to end (§2.4), so the runtime copies frames between fd 3 and the WS after checking/rewriting nothing but the per-direction framing.

### 2.4 Runtime ↔ desktop: one WS, multiplexed streams

**One WebSocket per user's desktop, many streams.** A page opens 50–200 connections, and a WS per stream would multiply TLS handshakes and auth checks. Frames are WS binary messages:

```
u8 type | u32 streamId | payload
OPEN    0x01  payload = u8 atyp | host | u16 port          (daemon → desktop)
OPENED  0x02  payload = u8 result (0 ok, else SOCKS reply code)   (desktop → daemon)
DATA    0x03  payload = bytes (≤ 32 KiB)
CREDIT  0x04  payload = u32 bytes                           (both ways)
FIN     0x05  half-close (TCP shutdown(WR))
RST     0x06  abort, u8 reason
PING    0x07 / PONG 0x08  u64 nonce                          (keep-alive, latency for the indicator)
HELLO   0x09  JSON {v:1, caps, limits}                       (first message both ways)
```

- **Stream ids** are allocated by the daemon (odd, increasing). The desktop never opens streams. A desktop-sent `OPEN` is a protocol error that closes the WS.
- **Backpressure:** per-stream credit windows (start 256 KiB, `CREDIT` returned as the receiver writes to its socket). A sender with no credit stops reading its socket (`pause()` in Node, stop polling in tokio). A connection-level cap keeps total unacked bytes per user at 8 MiB or less. Slow streams therefore don't stall others (no TCP-over-TCP global HOL beyond the single WS, which is acceptable).
- **Timeouts:** `OPEN` → `OPENED` 15 s (desktop connect timeout 10 s); stream idle 15 min (same as port forward); WS `PING` every 20 s, dead after 3 missed. On WS death every stream gets RST and the daemon answers new SOCKS requests with 0x01 immediately (fail closed, §4.3).
- **IPv6:** the desktop resolves `A` and `AAAA` and connects happy-eyeballs style (tokio: try v6 then v4 with a 250 ms stagger), so v6-only sites work if the user has v6. The guard runs on every candidate address.
- **Limits:** ≤ 256 concurrent streams per user (the daemon refuses beyond that with 0x01), host ≤ 255 bytes, frame payload ≤ 32 KiB.
- **Versioning:** `HELLO.v`. On mismatch the runtime reports `egress: incompatible app`, and the UI asks to update the app.

## 3. Security

### 3.1 Only this user's browser can use this user's tunnel

1. **Sandbox side (who may open a stream).** The SOCKS listener binds `127.0.0.1:0` (ephemeral). Without `FLOQ_NETNS`, all sandboxes share loopback, so on `accept` the daemon looks the peer up in `/proc/net/tcp{,6}` (the parser already exists in `ports.ts`; copy it into `floq-browserd-core.mts` to stay dependency-free):
   - the row whose local address is the peer's `ip:port` must have **uid == the daemon's uid**, and
   - its **inode must be held by a process in the Chromium tree** (descendants of the Chromium pid, `/proc/<pid>/fd` → `socket:[inode]`; the same approach as `ports.ts` `socketInodes`). The pid set is cached and refreshed on miss, which costs about 1 ms on a miss and nothing on a hit.
   - Anything else is closed without a SOCKS reply and logged `egress.peer_refused`. This also means the user's own agents cannot `curl --socks5` through the tunnel: only the browser egresses via the user's IP. The agents can still drive the browser through CDP, which is the product.
2. **Runtime (pairing).** The fd 3 pipe belongs to user U's daemon by construction (spawned by `BrowserService` for U). The `/v1/browser/egress` WS is authenticated like `/v1/browser/stream`: `authFor(headers)` → `userId`, no user id in the route, plus the `originAllowed` check. The runtime relays only between U's pipe and U's desktop socket. With several desktops online for U, the **most recently connected one that has the toggle on** wins, and the others get `HELLO {standby:true}`. The Settings row shows which machine is active ("via MacBook-Pro").
3. **Token.** This is the app's existing session token (the same as `/v1/events`), sent in the `Authorization` header from Rust. Native Rust can set headers, unlike port forwarding's `?token=`, so the token never lands in URLs or runtime access logs. Logout or session revocation closes the WS (the runtime already tracks `livePeers` by `authSessionId`, so add the egress socket there).

### 3.2 The desktop side is not an open proxy

`src-tauri/src/egress.rs` has a pure, unit-tested `fn guard(host, port, resolved: &[IpAddr], policy) -> Result<(), Deny>`:

- **No listening socket** on the user's machine, ever. Streams can only originate from the one authenticated runtime WS.
- **Ports:** default allow `{80, 443}` plus `{8080, 8443}`. Everything else is refused with `Deny::Port` (blocks SMTP 25, SSH, DBs). The Settings opt-in "Allow other ports" exists but stays hidden under Advanced.
- **Addresses (checked on every resolved IP, after DNS, and the connection is made to that exact checked IP, so there is no TOCTOU/rebinding):** refuse loopback (`127/8`, `::1`), RFC1918, CGNAT `100.64/10`, link-local `169.254/16` + `fe80::/10` (includes cloud metadata), ULA `fc00::/7`, multicast, unspecified, broadcast, `0/8`, documentation/benchmark ranges, IPv4-mapped/NAT64 `64:ff9b::/96`/6to4 `2002::/16` embeddings of any of these. This list mirrors `NETNS_BLOCKED_RANGES` in `runtime/src/netns.ts` plus the v6 set from §A.9 T6, written once in Rust as a table with tests.
- **Opt-in "Allow access to my local network"** (off by default, in Advanced, with copy "Agents could reach your router, printers and other devices"). Even with it on, loopback of the user's machine stays refused. It's a separate, scarier toggle that we do **not** ship in v1.
- **Caps (desktop enforced, defaults):** 256 concurrent streams, 60 new connections/s (burst 120), 50 Mbit/s and 10 GiB/day per user (the counter persists in app data and resets at local midnight). Hitting a cap → `RST` with a reason, and the indicator shows "Paused: limit reached".
- **DNS** goes through the OS resolver (`tokio::net::lookup_host`), so the user's own DNS, VPN and hosts file apply. That's what "user's connection" means.

### 3.3 Visibility and kill switch

- **The tray/title indicator** is a pulsing dot while there is any open stream, with a tooltip "Agent browser is using your connection · 12 connections · 3.4 MB/min". The window title bar badge shows the same thing (`desktop.rs` / `island.rs` already render status. Reuse that surface).
- **One switch to stop:** the tray menu and the indicator popover have **"Stop using my connection"**. It flips the setting off, RSTs every stream immediately and closes the WS, and the browser goes to the paused state (§4.3). Quitting the app has the same effect.
- **Local log:** a ring buffer of the last 500 `host:port, bytes, start, end, result` entries, viewable in Settings > Browser > "Recent connections". It stays local and is never sent anywhere. The user can see what their IP was used for.

### 3.4 Threat model additions (append to agent-browser.md §A.9)

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| E1 | Another tenant's sandbox uses U's tunnel (shared loopback). | Peer uid + Chromium-inode check (§3.1.1). Ephemeral port. | None known. |
| E2 | U's own agent uses U's IP for non-browser traffic (scraping, spam). | Inode check: only Chromium's sockets. **Assumes yama `ptrace_scope` ≥ 1 (1 on our hosts) and one pid namespace per sandbox**: with `ptrace_scope` 0 a same-uid agent could `pidfd_getfd` the daemon's fd 3 or a Chromium socket and bypass the check. fd 3 is never inherited by the daemon's helper processes (their slot 3 is `/dev/null`). The SOCKS listener also has a per-second accept budget and a rate-limited refusal log, so another tenant on the shared loopback cannot burn the daemon's CPU. Agents cannot pick their own proxy over CDP: `Target.createBrowserContext` loses `proxyServer`/`proxyBypassList`/`proxyBypassRules` in egress mode. | The agent can still drive Chromium to any http(s) URL. That's the feature. Caps + log + indicator bound it. |
| E3 | A web page or agent reaches the user's LAN, router or localhost services. | Desktop guard after DNS, connection to the checked IP, private ranges refused by default. **Also refused: every on-link prefix of this computer (IPv4 and IPv6, read with `getifaddrs`, refreshed every 30 s; global IPv6 LAN devices live there), the default gateway, and the computer's own public IP (the runtime sends the address the desktop connected from in its HELLO as `peer`; connecting to it from inside would hairpin to the router).** | With the LAN opt-in on, that's by user choice. |
| E4 | A compromised runtime or operator uses the user's machine as a proxy. | Ports 80/443 only, no private ranges, caps, visible indicator, local log, one-click stop, off by default. | The operator can relay public web traffic via the user's IP while the toggle is on. This is inherent and stated in the Settings copy. |
| E5 | DNS or WebRTC leaks reveal the VPS or the user mismatched. | Resolver rule, no local DNS, QUIC off, WebRTC `disable_non_proxied_udp`. | Timezone and locale of the headless browser are the VPS defaults (§6). |
| E6 | A session token in a URL or log. | Header auth from Rust. | None. |

## 4. UX

### 4.1 Settings > Browser

- **"Route browser traffic through this computer"** is off by default. It's only shown in the desktop app (`isTauri()`). The web build shows "Available in the desktop app".
  - Helper text: "Websites will see your internet connection and location instead of Floq's server. Your computer must be on with Floq open. Agents can then browse as you, from your IP."
  - When on, two more controls appear:
    - **If this computer is offline:** ( ) Pause the browser (default) · ( ) Use the server's connection.
    - **Advanced:** allowed ports, daily data cap, "Recent connections".
- The setting is **per user and per machine**. The user's desired mode (`agentBrowserEgress: "server" | "desktop" | "desktop-fallback"`) is stored in runtime settings (`settings.ts` `PublicSettings`/`SettingsPatch`), so the daemon knows whether to fail closed even when no app is connected. "This computer is the egress" is local app state, and the WS only connects when it's true.

### 4.2 Browser node badge

In the header, next to the URL bar:

- **"via your connection"** (green dot) when the mode is desktop and the WS is up. The tooltip names the machine and its latency.
- **"via server"** (neutral) when the mode is server, or desktop-fallback while offline. In the fallback case the badge is amber with "via server (your computer is offline)".
- **"paused"** (amber) when the mode is desktop and no egress is connected.

The data source is a new `egress {mode, state: up|down|standby, machine, rttMs}` message on `/v1/browser/stream` and in `GET /v1/browser`.

### 4.3 App closed or offline: fail closed

- Mode `desktop`, no desktop connected: the daemon keeps Chromium running with the proxy flags, and every SOCKS request is answered immediately with 0x01. **No request ever leaves via the VPS.** The Browser node shows an overlay: "Paused: the browser uses your computer's connection and Floq isn't open there. Open Floq on your computer, or switch to the server connection." It has buttons [Use server connection this time] and [Settings]. "This time" is a **transient runtime override** (`POST /v1/browser/egress/override {server:true}`, held in memory, never saved): the user's `desktop` / `desktop-fallback` choice and the Settings toggle are untouched, the relay keeps running on every machine, and the badge reads "via server (this time)". The override ends when a desktop of the user reaches `up` after having been down, when the user changes the mode, or when the browser goes idle or is disabled. The tray and the indicator kill switch still `PATCH {agentBrowserEgress:"server"}` (that is a real, saved stop).
- Agents get a clear MCP-visible error: navigation fails with `ERR_PROXY_CONNECTION_FAILED`, and the wired-context browser line gets: "If navigation fails with a proxy error, the user's computer is offline: ask the user with floq decision request." `/internal/browser/ensure` also returns `egress: "paused"` so the MCP wrapper can print it once.
- Mode `desktop-fallback`: on WS loss the runtime restarts the daemon onto the server route → Chromium restarts without the proxy. When the desktop comes back, it switches back the same way, with a restart. The badge always shows the truth. Live connections never switch silently: a restart is the only switch point, so a single page load never mixes IPs.
- Reconnect: the desktop retries the WS with backoff of 1, 2, 5, 10, 30 s. When the WS comes back up the overlay clears by itself, and the agent can retry.

## 5. Implementation plan

Order: R1 → D → T(runtime) can start in parallel with Rust; FE last. About 1 Sonnet implementer per track, but R and D are tightly coupled (same frame codec), so one implementer does both.

### R. Runtime (`runtime/src`)
1. `shard.ts`: `spawnPipe` option `extraPipe` → 4th stdio pipe (both drivers, lines ~444 and ~576).
2. New `browserEgress.ts`: frame codec (shared spec with the daemon; make it a small `.mts` in `runtime/image/` imported by both, like `floq-browserd-core.mts`), the `EgressHub` per user (pairs the daemon fd 3 with the active desktop WS, standby handling, connection-level cap, RST-all on either side going away), and state events.
3. `server.ts`: `/v1/browser/egress` upgrade (header auth via `authFor`, origin check, add to `livePeers`, close on logout). `GET /v1/browser` and the stream get the `egress` field.
4. `browser.ts`: spawn with `extraPipe`, wire to `EgressHub`, send `egress.set` on setting change / WS up/down (fallback mode), pass `FLOQ_BROWSER_EGRESS=desktop|server` env at spawn.
5. `settings.ts`: `agentBrowserEgress` field + patch validation.
6. `browserProtocol.ts`: add `egress.set` (runtime → daemon) and `egress {state}` (daemon → runtime) to the allowlist.

### D. Browser daemon (`runtime/image/floq-browserd*.mts`)
1. `chromiumArgs({..., egress})` adds the §2.2 flags. Restart on `egress.set`.
2. SOCKS5 server (≈150 lines in core: greeting, CONNECT parse, reply) + peer check (`/proc/net/tcp` parse + Chromium-tree inode set).
3. Mux client on fd 3: stream table, credits, fail-closed replies when the hub reports down.
4. T6 interceptor: skip DNS resolution when egress is on (literal and `localhost` checks only).

### Rust (`src-tauri/src/egress.rs`, `lib.rs`)
1. `egress_start(url, token, policy)` / `egress_stop()` / `egress_status()` commands, modeled on `port_forward.rs` (`tokio_tungstenite::connect_async` with a request carrying `Authorization`).
2. Mux server side: stream table, `lookup_host`, guard, happy-eyeballs connect to the **checked** IP, credits, caps (token bucket + daily counter in the app data dir), ping/pong.
3. Events to the frontend (`egress://status` with stream count, bytes/min, rtt) for the indicator. Tray menu item "Stop using my connection".
4. The pure `guard` with a table-driven test module.

### FE (`src/`)
1. `src/lib/browser-egress.ts`: the desktop-only store (like `port-forwarding.ts`), which starts and stops the Rust relay from the setting and reconnects.
2. Settings > Browser controls (§4.1), with the "Recent connections" list from `egress_status`.
3. `browser-node.tsx`: badge + paused overlay.
4. Title/tray indicator via the existing desktop status surface.

### T. Tests
- **Rust unit (`cargo test`, recipe in floq memory `61f146a6`):** guard table covering every blocked v4/v6 range, mapped/NAT64/6to4 embeddings, ports, the opt-ins, IDN/uppercase hosts, an over-long host; frame codec round-trip; credit accounting; caps.
- **Runtime unit (`runtime/test`):** codec; `EgressHub` pairing (user A's pipe never reaches user B's WS, standby, RST-all on drop); `/v1/browser/egress` refuses without a token, with a wrong origin, and with the token in the query; settings validation.
- **Daemon (`runtime/test/browserDaemon.test.mts` + fake Chromium):** flags present only in egress mode; SOCKS refuses a peer of another uid and a same-uid non-Chromium peer (an inode not in the tree); fail-closed 0x01 when the hub is down; BIND/UDP refused.
- **End-to-end (local, no VPS):** a test harness starts the runtime + daemon with real Chromium, and a **fake desktop peer** (a small Node process implementing the desktop half of the mux, egressing via a second loopback-bound source address or a network namespace, or more simply an HTTP stub "ipify" that echoes the TCP peer address). Assert that the page at `http://ipify.test/` (mapped via the fake peer's resolver) returns the fake peer's source address, not the daemon's. A second run against the real `https://api.ipify.org` with the actual Tauri relay is a **manual** check documented in the PR (the CI host and the "desktop" share an IP, so it proves nothing automatically).
- **Leak checks in e2e:** with the fake peer down, navigation fails (no direct egress); `chrome://net-export`-style check that no DNS query hits the local resolver (run with a resolver stub that fails the test on any query).

## 6. Limits and honesty (put this in the Settings help and release notes)

**What it does:** sites see the user's IP, ISP and approximate location. IP-reputation blocks aimed at datacenter ranges, "unusual traffic from your network", geo-restricted content, and the "new location" login challenges caused by the VPS IP should go away or calm down.

**What it does not do:**
- It does **not** make the headless browser look human. Cloudflare Turnstile/managed challenges, DataDome and similar score browser signals (headless traits, automation via CDP, TLS/HTTP2 fingerprint of the Chromium build, missing GPU, input timing) as well as IP. Those challenges **may still appear**. The user can solve them in the Browser node as today.
- No stealth: we don't change the UA, `navigator.webdriver`, or fingerprints. That's a deliberate product decision, and nothing here should be read as evasion.
- Timezone, locale and fonts stay the VPS's. Sites may notice an IP/timezone mismatch. (Optional follow-up: set the browser timezone/locale to the user's, as an explicit user preference for correct local times, not as camouflage.)
- It costs the user's bandwidth and latency: each request makes an extra round trip VPS ⇄ user. Expect noticeably slower page loads when the user is far from the server or on a weak uplink.
- It only works while the user's computer is on, online, and running Floq.
- Responsibility: traffic from the agent browser comes from the user's IP. The Settings copy says so plainly.

## 6b. CAPTCHA changes (v1.0.37, see browser-captcha-research.md)

A person must be able to solve Turnstile / reCAPTCHA / hCaptcha in the node. What changed in the browser, none of it driven by agents:

- **Headful on Xvfb.** `floq-browserd` starts a private Xvfb (`-displayfd`, TCP off) sized like the user's screen and runs Chromium on it, so the UA and client hints no longer say `HeadlessChrome`. The CDP screencast and `Input.dispatch*` are unchanged. Without Xvfb (or when it cannot start, or `FLOQ_BROWSER_HEADLESS=1`) it falls back to `--headless=new`; `ready.display` says which ("xvfb" | "headless").
- **The user's machine.** The app puts `env=` (screen size, DPR, `Intl` timezone, `navigator.languages`, `(pointer:fine)`, `(hover:hover)`) on the browser stream URL. The runtime validates it (`sanitizeClientEnv`) and hands it to the next daemon start as `FLOQ_BROWSER_CLIENT_ENV` + `TZ`; the daemon applies `--lang` / `--accept-lang`, `--blink-settings` (hover / fine pointer), `--screen-info` (headless only) and `screenWidth/Height` in `Emulation.setDeviceMetricsOverride`. Plain facts about the user's machine, nothing invented. It does not take effect on a daemon that is already running (never restarted for this).
- **Challenge frames are left alone.** For `challenges.cloudflare.com`, `www.google.com/recaptcha`, `recaptcha.net`, `*.hcaptcha.com` the daemon only resumes the paused frame: no `Page.enable`, `Fetch.enable` or auto-attach hook, and no `Runtime.evaluate` cursor probe while such a frame exists. (T6 loses nothing: public hosts, and with egress on the desktop guard is the boundary.)
- **Stable session.** No route switch mid-load / mid-login (above); session cookies survive restarts.
- **Not changed:** `navigator.webdriver` stays true. The single place a flag would go is `WEBDRIVER_DECISION_FLAGS` in `runtime/image/floq-browserd.mts`, pending a product decision (it reverses the "no stealth" stance of §6).

## 7. Effort and risks

| Track | Effort (one implementer, incl. tests) |
|---|---|
| Runtime hub + route + settings + fd 3 | 2–3 days |
| Daemon SOCKS + peer check + mux + flags/restart | 2–3 days |
| Rust relay + guard + caps + tray | 3–4 days |
| Frontend (setting, badge, overlay, indicator, recent list) | 1.5–2 days |
| E2E harness + leak checks + manual Tauri check | 1.5–2 days |
| **Total** | **≈ 10–14 dev-days**, about 2 calendar weeks with review |

Risks:
- **Performance:** the double hop plus WS framing (TCP-over-TCP) under loss is slow. Mitigate with credits, 32 KiB frames, and the per-stream window. Measure page load on a typical site before shipping, and show latency in the badge tooltip.
- **Peer check portability:** reading `/proc/<pid>/fd` of Chromium children from the daemon. Children run as the same uid in the same pid namespace, so it should work. Verify it under `--unshare-pid` bwrap and with the Chromium sandbox on (zygote processes may restrict fd reading via `PR_SET_DUMPABLE=0`). **Fallback:** the uid check alone + document E2 as broader. Decide in implementation after a 1-hour spike.
- **bwrap fd passing for fd 3** with `--die-with-parent`: verify early (spike).
- **Chromium restart on toggle**: session cookies are saved to `~/.floq/browser/session-state.json` (every 5 s and on shutdown) and restored at the next start, so a restart no longer logs the user out. The restart itself is still an IP change, so the runtime never does it while a page is loading or within 15 s of a click / key from the user (it retries every 2 s, for at most 90 s).
- **Multi-device** "which machine is active" confusion, mitigated by naming the machine in the badge and in Settings.
- **Abuse via the operator or a compromised runtime (E4):** inherent. Off by default, visible, caps, one-click stop.
- **Deployment:** the runtime ships via Dokploy on push to main (lead pushes), and the desktop part needs an app release. Ship the runtime first with the feature gated on `HELLO` from a capable app, so old apps simply don't offer the toggle.
