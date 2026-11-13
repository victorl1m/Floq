# Browser egress wire protocol (v1)

Normative companion to `docs/design/browser-user-egress.md` §2.3/§2.4. The desktop side (`src-tauri/src/egress.rs`) and the runtime/daemon side must agree on exactly this. If you change a byte here, change both and tell the other implementer.

All integers are **big endian**. One WebSocket binary message = one frame. Text WS messages are a protocol error (close 1008). The same frame format is used on the daemon↔runtime fd 3 pipe, with each frame prefixed by `u32 length` (the length of the frame that follows) because a pipe has no message boundaries; the runtime strips/adds that prefix and copies frames otherwise unchanged.

## Connection (desktop → runtime)

- URL: `wss://<runtime>/v1/browser/egress` (no query string, no user id, no token in the URL).
- Headers: `Authorization: Bearer <session token>` (the same token as `/v1/events`). `Origin` is **not** sent by the Rust client (non-browser client); the runtime's `originAllowed` must accept a request with no Origin from a bearer-authenticated client.
- The desktop dials only when the user's local toggle is on, and closes the socket the moment it is turned off, the kill switch is used, or the app quits.
- Reconnect backoff on the desktop: 1, 2, 5, 10, 30 s (then stays at 30 s). Reset on a successful HELLO.

## Frame

```
u8 type | u32 streamId | payload
```

`streamId` is 0 for HELLO/PING/PONG. Stream ids are allocated by the daemon: odd, increasing from 1. A frame with an unknown type is ignored (forward compatibility; the hub does this for a ready desktop), except that any unknown type before HELLO is a protocol error.

| type | name | dir | payload |
|---|---|---|---|
| 0x01 | OPEN | daemon → desktop | `u8 atyp` `host` `u16 port`. atyp 0x01: host = 4 bytes (IPv4). atyp 0x03: host = `u8 len` + `len` bytes ASCII/UTF-8 name (1..255). atyp 0x04: host = 16 bytes (IPv6). |
| 0x02 | OPENED | desktop → daemon | `u8 result`: 0 = connected, otherwise the SOCKS5 reply code (0x01 general failure/offline, 0x02 not allowed by guard, 0x03 network unreachable, 0x04 host unreachable/DNS failure, 0x05 connection refused, 0x06 TTL expired/timeout, 0x07 command not supported, 0x08 address type not supported). |
| 0x03 | DATA | both | raw bytes, 1..32768 |
| 0x04 | CREDIT | both | `u32` bytes the sender of this frame is willing to receive on this stream |
| 0x05 | FIN | both | empty. Half-close: the sender will send no more DATA on this stream (TCP `shutdown(WR)`). |
| 0x06 | RST | both | `u8 reason`. Aborts the stream both ways; the receiver closes its socket and forgets the stream. |
| 0x07 | PING | both | `u64 nonce` |
| 0x08 | PONG | both | `u64 nonce` (echo) |
| 0x09 | HELLO | both | UTF-8 JSON, see below. Must be the first frame each side sends. |

### RST reasons

`0` generic/unknown · `1` guard (port or address refused) · `2` stream cap · `3` connection-rate cap · `4` bandwidth cap · `5` daily data cap · `6` idle timeout · `7` protocol error · `8` kill switch / user stopped · `9` shutdown (app quitting or WS closing) · `10` upstream error (connected socket failed, e.g. ECONNRESET) · `11` link down (sent by the runtime hub: the desktop that owned the stream is no longer the active one, or the link dropped). The numbers are the same in `runtime/src/egressCodec.ts`, `runtime/image/floq-egress-codec.mts` and `src-tauri/src/egress.rs`; `runtime/test/browserEgress.test.mts` reads the Rust constants and fails on drift.

An `RST` for a stream that has not yet received `OPENED` takes the place of the `OPENED` failure; the daemon answers the SOCKS request with 0x01 (general failure) whatever the reason; the desktop uses OPENED with a specific code when it can (0x02 for a guard refusal).

### HELLO

Runtime → desktop (first message, sent by the hub the moment the WebSocket is attached; **the desktop waits for it and the runtime does not wait for the desktop before sending it**, so neither side deadlocks):
```json
{"v":1,"role":"runtime","peer":"203.0.113.9"}
```
- `peer` (optional): the address the runtime saw the desktop connect from (the first `X-Forwarded-For` entry if a proxy sets it, else the socket address), i.e. the desktop's public IP. The desktop refuses it as an egress target (hairpin to its own router), together with every on-link prefix of this computer and its default gateway (design §3.2).
Desktop → runtime (in reply, and the runtime waits for it before relaying anything):
```json
{"v":1,"role":"desktop","machine":"MacBook-Pro","app":"1.0.10","caps":["egress"],
 "limits":{"streams":256,"frame":32768,"window":262144,"portsAllowed":[80,443,8080,8443]}}
```
- `machine`: the computer's host name, shown in Settings and the badge tooltip. At most 64 chars; the runtime truncates and strips control characters.
- On `v` mismatch the runtime closes the WS with code **4400** and reports `egress: incompatible app` in its state; the desktop reports "update the app".
- Runtime → desktop `{"v":1,"role":"runtime","standby":true}` follows when another desktop of the same user is active (most recently connected one with the toggle on wins). A standby desktop must hold the socket open, open no streams, and show "Another computer is being used". If it becomes active later the runtime sends `{"v":1,"role":"runtime","standby":false}` (HELLO may be sent again with the same shape at any time on stream 0).
- Both sides ignore unknown JSON fields.
- At most 8 WebSockets per user; a ninth closes the oldest with 1008.

## Streams

1. Daemon sends `OPEN` (stream id odd). The desktop must reply with exactly one of `OPENED` or `RST` within 10 s (its connect timeout). The runtime/daemon give up after 15 s with SOCKS reply 0x06.
2. The desktop never sends `OPEN`. A desktop-sent `OPEN` is a protocol error (the runtime closes the WS with **4401**).
3. After `OPENED 0` both sides exchange `DATA`, `CREDIT`, `FIN`. A stream is finished when both directions have sent `FIN`, or when either side sends/receives `RST`.
4. **Credits.** Each side starts with a receive window of **262144** bytes per direction per stream and may send up to the peer's window without waiting. The receiver returns `CREDIT n` after it has *written* `n` received bytes to its socket. A sender never sends more than the credit it holds (the daemon splits and queues socket reads accordingly, and its credit never exceeds the window); with less than one chunk of credit it stops reading its socket. The hub re-encodes every `CREDIT` clamped to the bytes it accounts for, so a peer never holds more than one window. `DATA` that overruns the window is a protocol violation: `RST 7` for that stream. Connection-level cap: total unacknowledged bytes per user ≤ 8 MiB, enforced by the runtime hub (it RSTs the stream that exceeds it).
5. **Limits.** At most 256 concurrent streams per user (the daemon refuses beyond that with SOCKS 0x01 and the desktop RSTs with reason 2). Host ≤ 255 bytes. Frame payload ≤ 32768.
6. **Idle:** a stream with no DATA in either direction for 15 min is closed with `RST 6`.
7. **Keep-alive:** either side may send `PING`; the receiver answers `PONG` with the same nonce at once. The runtime pings every 20 s and treats 3 missed PONGs as dead; the RTT it measures is what the badge shows. The desktop also pings every 20 s for its own indicator.
8. When the WS closes, every stream on both sides is reset locally (no frames needed). The daemon answers new SOCKS requests with 0x01 while the hub is down.

## Local desktop interface (Tauri) — informational

Not part of the wire, but the runtime/UI halves rely on these:

- `egress_start({url, token, policy})` → starts the relay (dials `url` with the bearer header). `policy = {allowOtherPorts: bool, dailyCapBytes: number}`.
- `egress_stop()`, `egress_status()` → `{running, state: "off"|"connecting"|"up"|"standby"|"error", error?, streams, bytesPerMin, rttMs, usedToday, dailyCap, recent: [{host, port, bytes, start, end, result}], machine}`.
- Event `egress://status` carries the same status object (throttled to 1/s while streams are open).
- Runtime reports to the browser UI `egress {mode, state: "up"|"down"|"standby", machine, rttMs}` on `/v1/browser/stream` and in `GET /v1/browser` (this is the runtime side, see §4.2 of the design).

## App-facing contract (runtime ↔ UI) — what the frontend implements

- Runtime setting `agentBrowserEgress: "server" | "desktop" | "desktop-fallback"` in `GET/PATCH /v1/settings` (`PublicSettings` / `SettingsPatch`). Absent = `"server"`. Unknown values must be rejected with 400.
- `/v1/browser/stream` sends, right after `state`, and again on every change: `{"type":"egress","mode":<mode>,"state":"up"|"down"|"standby","machine"?:string,"rttMs"?:number}`. `GET /v1/browser` returns the same object (without `type`) as `egress`.
  - The UI shows: mode `server` → "via server"; `desktop`+`up` → "via your connection"; `desktop`+`down` → "paused" + overlay; `desktop-fallback`+`down` → "via server (your computer is offline)"; `standby` → "via your connection" (another computer is active).
- The desktop app starts its relay only when this machine's local toggle is on AND the mode is not `server`; the kill switch (tray, indicator) `PATCH`es `{agentBrowserEgress:"server"}` (a real, saved stop), while "Use server connection this time" calls `POST /v1/browser/egress/override {server:true}` (transient, in memory on the runtime; the setting and the relay are untouched; the viewer message and `GET /v1/browser` carry `override:true` and the badge reads "via server (this time)"; it ends when a desktop reaches `up` after having been down, when the mode is changed, or when the browser goes idle/disabled).
- The app sends `Authorization: Bearer <token>` and **no `Origin`**: `/v1/browser/egress` must accept that (token auth is the check; browsers always send Origin and are refused when it is not allowed).

## Implementation notes (runtime + daemon, as built)

- **Runtime shape of the viewer message** (`runtime/src/browser.ts` `egressStatus`): `{type:"egress", mode, effective:"server"|"desktop", state:"up"|"down", machine?, rttMs?, override?:true}`. `mode` is the setting, `effective` is what the *running* daemon does (fixed at spawn). `state` is `"up"` only when `mode != server` and a desktop is connected and active; otherwise `"down"` (for `mode: "server"` the UI keys on `mode`). The runtime never reports `standby` to viewers: standby is known only to the standby desktop itself, via `HELLO {standby:true}`. `GET /v1/browser` returns the same object, without `type`, as `egress` (absent when the server has no relay).
- **Route switch is a runtime-driven daemon restart**, not a daemon-internal `egress.set`: `BrowserService.restart()` (the existing 5 s clean shutdown, session cookies and node URLs saved to `session-state.json`) respawns the daemon with `FLOQ_BROWSER_EGRESS=desktop|server`. The `egress.set` control messages are not used for switching. The daemon still prints `{type:"egress", state:"up"|"down"}` on stdout when its LINK changes (the runtime ignores it; diagnostics only). Switching happens: on `PATCH /v1/settings {agentBrowserEgress}`, and for `desktop-fallback` when a desktop connects or the last one leaves (debounced 1.5 s).
- **fd 3** exists only when the daemon runs in `desktop` mode (`ShardDriver.spawnPipe({extraPipe:true})`). In `desktop` mode the daemon refuses to start without it (`start_failed`), so Chromium never runs unproxied.
- **`ensure()`** (`/internal/browser/ensure`) adds `egress: "paused"` when the daemon is in `desktop` mode and no desktop is connected.
- **Route-change events:** the hub calls `onChange(userId, rttOnly)`; a PONG-only rtt update (about every 20 s per desktop) skips the route re-evaluation and its settings reads.
- **Peer check** is `uid == daemon uid` AND the connection's socket inode is held by a process in the Chromium tree (`/proc/<pid>/fd`). Verified with the real full Chromium (network service is a child utility process whose fds are readable by the same uid, also under `--no-sandbox`). `FLOQ_BROWSER_EGRESS_PEER=uid` is the documented fallback (uid only) if a future Chromium makes those fds unreadable.
- **CDP:** in desktop mode the CdpMux strips `proxyServer`, `proxyBypassList` and `proxyBypassRules` from `Target.createBrowserContext`, so an agent cannot give a context its own route (`direct://` would leave from the server).
- **fd 3 hygiene:** helper processes the daemon spawns (`--version`, `command -v prlimit`) get `/dev/null` in slot 3; Chromium overwrites slot 3 with its own CDP pipe.

## Stream ids across daemon restarts (fix in v1.0.12)

The desktop admits OPEN ids that are odd and strictly increasing for the whole life of its WebSocket and answers a regression with a
protocol error (it drops the link). A restarted daemon numbers its streams from 1 again while the desktop WebSocket stays up, so the
runtime hub shifts every daemon stream id by an even per-user base (the highest desktop-side id handed out so far) on the way to the
desktop and removes it on the way back. The daemon and the desktop are unchanged; frames for an earlier daemon's streams arrive with
ids at or below the base and are ignored.
