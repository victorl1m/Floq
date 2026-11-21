// Pure, testable parts of floq-browserd (docs/design/agent-browser.md §A.2, §A.5, §A.9):
//   - validation of every control message the runtime sends (types, ranges, key allowlist, URL scheme rule)
//   - a minimal RFC 6455 server (upgrade gate + frame codec), so the daemon needs no npm dependency
//   - CdpMux: shares ONE CDP pipe between several agents' clients (session ids stay unique per client; commands, responses
//     and events are routed by id/sessionId; a client can never use another client's or the daemon's session)
//   - private-network host check used by the optional Fetch interceptor (T6)
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 4096;
export const MAX_URL_CHARS = 2048;
export const MAX_TABS = 20;
export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_AGENT_CLIENTS = 16;
export const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

/** What the desktop app tells the runtime about the user's machine when it opens a Browser node, so the browser reports true facts (not UTC / 800x600 / no mouse). */
export type ClientEnv = { screenW: number; screenH: number; dpr: number; tz?: string; langs: string[]; pointerFine?: boolean; hover?: boolean };
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
/** Rebuilds the env field by field; anything off is dropped, an unusable value gives null. Copy of runtime/src/browserProtocol.ts: the daemon re-validates what the runtime passes in FLOQ_BROWSER_CLIENT_ENV. */
export function sanitizeClientEnv(raw: unknown): ClientEnv | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;
  const screenW = int(m.screenW, 640, 7680), screenH = int(m.screenH, 480, 4320);
  if (screenW === null || screenH === null) return null;
  const dpr = typeof m.dpr === "number" && Number.isFinite(m.dpr) && m.dpr >= 0.5 && m.dpr <= 4 ? Math.round(m.dpr * 100) / 100 : 1;
  const langs = Array.isArray(m.langs) ? m.langs.filter((l): l is string => typeof l === "string" && l.length <= 35 && LANG_RE.test(l)).slice(0, 5) : [];
  const tz = typeof m.tz === "string" && m.tz.length <= 64 && TZ_RE.test(m.tz) && validTimeZone(m.tz) ? m.tz : undefined;
  return { screenW, screenH, dpr, ...(tz ? { tz } : {}), langs, ...(typeof m.pointerFine === "boolean" ? { pointerFine: m.pointerFine } : {}), ...(typeof m.hover === "boolean" ? { hover: m.hover } : {}) };
}
function validTimeZone(tz: string): boolean { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }

// ---------------------------------------------------------------- validation

export type Control =
  | { type: "hello" }
  | { type: "screencast.start"; targetId: string; maxW: number; maxH: number; quality: number }
  | { type: "screencast.stop"; targetId?: string }
  | { type: "frame.ack"; n: number }
  | { type: "input.mouse"; targetId?: string; kind: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: "none" | "left" | "middle" | "right"; buttons: number; clickCount: number; modifiers: number }
  | { type: "input.wheel"; targetId?: string; x: number; y: number; dx: number; dy: number; modifiers: number }
  | { type: "input.key"; targetId?: string; kind: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key: string; code: string; text: string; modifiers: number }
  | { type: "input.text"; targetId?: string; text: string }
  | { type: "nav.go"; targetId?: string; url: string }
  | { type: "dialog.reply"; targetId?: string; accept: boolean; text?: string }
  | { type: "nav.back" | "nav.forward" | "nav.reload" | "nav.stop"; targetId?: string }
  | { type: "viewport"; targetId: string; width: number; height: number; dpr: number }
  /** One page per Browser node: idempotent open (adopts an unclaimed user tab first), close, and agent scoping by link. */
  | { type: "page.open"; nodeId: string; url?: string }
  | { type: "page.close"; nodeId: string }
  | { type: "agent.scope"; agent: string; nodeId: string | null }
  | { type: "shutdown" };

export type Validated = { ok: true; msg: Control } | { ok: false; code: string };

const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
export const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const AGENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const CODE_NAME = /^[A-Za-z0-9]{1,32}$/;
const NAMED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "Insert", "Shift", "Control", "Alt", "Meta", "CapsLock", "ContextMenu", "Process", "Dead",
  ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1)),
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isInt = (v: unknown, min: number, max: number): v is number => isNum(v, min, max) && Number.isInteger(v);
const textOk = (v: unknown): v is string => typeof v === "string" && Buffer.byteLength(v, "utf8") <= MAX_TEXT_BYTES;

/** http:, https: and about:blank only (UI path). Returns the normalized href, or null. Rejects control characters outright,
 *  because the WHATWG parser silently strips tabs/newlines and leading spaces ("java\nscript:" style tricks). */
export function normalizeNavUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL_CHARS) return null;
  for (const ch of raw) { const c = ch.codePointAt(0)!; if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return null; }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host ? parsed.href : null;
  if (parsed.protocol === "about:" && parsed.href === "about:blank") return "about:blank";
  return null;
}

export function validateControl(input: unknown, viewport: { w: number; h: number } = DEFAULT_VIEWPORT): Validated {
  const bad = (code = "bad_message"): Validated => ({ ok: false, code });
  if (!isObject(input) || typeof input.type !== "string") return bad();
  const m = input;
  const optTarget = (): string | undefined | false => (m.targetId === undefined ? undefined : typeof m.targetId === "string" && TARGET_ID.test(m.targetId) ? m.targetId : false);
  switch (m.type) {
    case "hello": return { ok: true, msg: { type: "hello" } };
    case "shutdown": return { ok: true, msg: { type: "shutdown" } };
    case "screencast.stop": { const targetId = optTarget(); return targetId === false ? bad() : { ok: true, msg: { type: "screencast.stop", ...(targetId ? { targetId } : {}) } }; }
    case "viewport": {
      if (typeof m.targetId !== "string" || !TARGET_ID.test(m.targetId) || !isInt(m.width, 200, 3840) || !isInt(m.height, 200, 2160) || !isNum(m.dpr, 0.5, 4)) return bad();
      return { ok: true, msg: { type: "viewport", targetId: m.targetId, width: m.width, height: m.height, dpr: m.dpr } };
    }
    case "page.open": {
      if (typeof m.nodeId !== "string" || !NODE_ID.test(m.nodeId)) return bad();
      if (m.url === undefined) return { ok: true, msg: { type: "page.open", nodeId: m.nodeId } };
      const url = normalizeNavUrl(m.url);
      return url ? { ok: true, msg: { type: "page.open", nodeId: m.nodeId, url } } : bad("bad_url");
    }
    case "page.close": return typeof m.nodeId === "string" && NODE_ID.test(m.nodeId) ? { ok: true, msg: { type: "page.close", nodeId: m.nodeId } } : bad();
    case "agent.scope": {
      if (typeof m.agent !== "string" || !AGENT_ID.test(m.agent)) return bad();
      if (m.nodeId !== null && (typeof m.nodeId !== "string" || !NODE_ID.test(m.nodeId))) return bad();
      return { ok: true, msg: { type: "agent.scope", agent: m.agent, nodeId: m.nodeId as string | null } };
    }
    case "screencast.start": {
      if (typeof m.targetId !== "string" || !TARGET_ID.test(m.targetId) || !isInt(m.maxW, 1, 1600) || !isInt(m.maxH, 1, 1200) || !isInt(m.quality, 1, 100)) return bad();
      return { ok: true, msg: { type: "screencast.start", targetId: m.targetId, maxW: m.maxW, maxH: m.maxH, quality: m.quality } };
    }
    case "frame.ack": return isInt(m.n, 0, Number.MAX_SAFE_INTEGER) ? { ok: true, msg: { type: "frame.ack", n: m.n } } : bad();
    case "input.mouse": {
      const kind = m.kind; // `type` names the message, so the CDP event type travels in `kind`
      if (kind !== "mousePressed" && kind !== "mouseReleased" && kind !== "mouseMoved") return bad();
      if (!isNum(m.x, 0, viewport.w) || !isNum(m.y, 0, viewport.h)) return bad();
      const button = m.button ?? "none";
      if (button !== "none" && button !== "left" && button !== "middle" && button !== "right") return bad();
      const clickCount = m.clickCount ?? 0;
      const modifiers = m.modifiers ?? 0;
      const buttons = m.buttons ?? 0;
      const targetId = optTarget();
      if (targetId === false || !isInt(clickCount, 0, 3) || !isInt(modifiers, 0, 15) || !isInt(buttons, 0, 31)) return bad();
      return { ok: true, msg: { type: "input.mouse", ...(targetId ? { targetId } : {}), kind, x: m.x, y: m.y, button, buttons, clickCount, modifiers } };
    }
    case "input.wheel": {
      if (!isNum(m.x, 0, viewport.w) || !isNum(m.y, 0, viewport.h) || !isNum(m.dx, -10000, 10000) || !isNum(m.dy, -10000, 10000)) return bad();
      const modifiers = m.modifiers ?? 0;
      const targetId = optTarget();
      if (targetId === false || !isInt(modifiers, 0, 15)) return bad();
      return { ok: true, msg: { type: "input.wheel", ...(targetId ? { targetId } : {}), x: m.x, y: m.y, dx: m.dx, dy: m.dy, modifiers } };
    }
    case "input.key": {
      const kind = m.kind;
      if (kind !== "keyDown" && kind !== "keyUp" && kind !== "rawKeyDown" && kind !== "char") return bad();
      const key = m.key;
      if (typeof key !== "string" || !key) return bad();
      const printable = [...key].length === 1 && key.codePointAt(0)! >= 0x20 && key.codePointAt(0)! !== 0x7f;
      if (!printable && !NAMED_KEYS.has(key)) return bad();
      const code = m.code ?? "";
      if (typeof code !== "string" || (code !== "" && !CODE_NAME.test(code))) return bad();
      const text = m.text ?? "";
      if (typeof text !== "string" || [...text].length > 8) return bad();
      const modifiers = m.modifiers ?? 0;
      if (!isInt(modifiers, 0, 15)) return bad();
      const targetId = optTarget();
      if (targetId === false) return bad();
      return { ok: true, msg: { type: "input.key", ...(targetId ? { targetId } : {}), kind, key, code, text, modifiers } };
    }
    case "input.text": { const targetId = optTarget(); return targetId !== false && textOk(m.text) ? { ok: true, msg: { type: "input.text", ...(targetId ? { targetId } : {}), text: m.text } } : bad(); }
    case "dialog.reply": {
      const targetId = optTarget();
      if (targetId === false || typeof m.accept !== "boolean" || (m.text !== undefined && (typeof m.text !== "string" || m.text.length > 4096))) return bad();
      return { ok: true, msg: { type: "dialog.reply", ...(targetId ? { targetId } : {}), accept: m.accept, ...(typeof m.text === "string" ? { text: m.text } : {}) } };
    }
    case "nav.go": {
      const targetId = optTarget();
      const url = normalizeNavUrl(m.url);
      if (targetId === false || !url) return bad("bad_url");
      return { ok: true, msg: { type: "nav.go", ...(targetId ? { targetId } : {}), url } };
    }
    case "nav.back": case "nav.forward": case "nav.reload": case "nav.stop": {
      const targetId = optTarget();
      if (targetId === false) return bad();
      return { ok: true, msg: { type: m.type, ...(targetId ? { targetId } : {}) } };
    }
    default: return bad();
  }
}

// ------------------------------------------------------------ private hosts (T6)

/** True for loopback, link-local, RFC1918, CGNAT, unique-local and other non-public addresses (v4, v6, v4-mapped v6). */
export function isPrivateAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(a);
  if (kind === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) || (p === 192 && q === 0) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (kind === 6) {
    const mapped = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    const hex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join(".")); }
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address: judge the embedded one.
    const nat = /^64:ff9b::(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a);
    if (nat) return nat[1] ? isPrivateAddress(nat[1]) : isPrivateAddress([parseInt(nat[2], 16) >> 8, parseInt(nat[2], 16) & 255, parseInt(nat[3], 16) >> 8, parseInt(nat[3], 16) & 255].join("."));
    if (a.startsWith("64:ff9b:")) return true; // other NAT64 forms (local-use prefix): refuse
    if (/^2002:/.test(a)) {
      const g = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(a);
      if (!g) return true;
      const hi = parseInt(g[1], 16), lo = parseInt(g[2], 16);
      return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
    }
    return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith("ff");
  }
  return false;
}

/** Host part of a request URL, or null when it has none (data:, about:, blob: and similar never touch the network). */
export function requestHost(rawUrl: string): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:" && u.protocol !== "ftp:") return null;
  return u.hostname.replace(/^\[|\]$/g, "");
}

export type Resolver = (host: string) => Promise<string[]>;

/** True when the request must be refused: its host is, or resolves to, a non-public address. A resolution failure is refused too
 *  (fail closed: a lookup that fails here must not be retried by Chromium against a different answer); localhost names are refused without a lookup. */
export async function shouldBlockHost(host: string, resolve: Resolver, opts: { literalOnly?: boolean } = {}): Promise<boolean> {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIP(h) || isIP(h.replace(/^\[|\]$/g, ""))) return isPrivateAddress(h);
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // Egress mode: names are resolved (and checked) by the desktop; a lookup here would leak DNS to the VPS and be the wrong answer anyway.
  if (opts.literalOnly) return false;
  let addrs: string[];
  try { addrs = await resolve(h); } catch { return true; }
  if (!addrs.length) return true;
  return addrs.some(isPrivateAddress);
}

// ------------------------------------------------------------------ tokens

export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const m = /^Bearer (.+)$/.exec(given);
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ------------------------------------------------------------- WebSocket

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Per-agent endpoint token: HMAC of the agent id under the daemon-wide secret, which never leaves the runtime. */
export function agentToken(master: string, agent: string): string {
  return createHmac("sha256", master).update("floq-browser-agent:" + agent).digest("hex");
}

/** The agent a connection claims through `?agent=`: undefined = none, null = malformed. */
export function claimedAgent(url: string | undefined): string | null | undefined {
  const v = new URL(url ?? "/", "http://127.0.0.1").searchParams.get("agent");
  if (v === null) return undefined;
  return AGENT_ID.test(v) ? v : null;
}

/** The upgrade gate (T1, T2): path, Host, Origin and bearer token. Returns an HTTP status to refuse with, or 0 to accept.
 *  A connection naming an agent must present THAT agent's token (the claimed id is authenticated, never trusted); with no `?agent=` the daemon-wide token is required. */
export function checkUpgrade(req: IncomingMessage, port: number, token: string, path = "/devtools/browser"): number {
  if (req.headers.origin !== undefined) return 403;
  if (req.headers.host !== "127.0.0.1:" + port) return 403;
  let claimed: string | null | undefined;
  try { claimed = claimedAgent(req.url); } catch { return 400; }
  if (claimed === null) return 401;
  if (!tokenMatches(req.headers.authorization, claimed === undefined ? token : agentToken(token, claimed))) return 401;
  if ((req.url ?? "").split("?")[0] !== path) return 404;
  if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13") return 400;
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) return 400;
  return 0;
}

export function refuseUpgrade(socket: Duplex, status: number): void {
  const text = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
  socket.end("HTTP/1.1 " + status + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex): void {
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => {
    const h = Buffer.alloc(10);
    h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2);
    return h;
  })();
  return Buffer.concat([head, payload]);
}

/** Incremental decoder of CLIENT frames (masking required, fragmentation supported, size-capped). */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partBytes = 0;
  private partOpcode = 0;
  constructor(private onMessage: (opcode: number, data: Buffer) => void, private onProtocolError: (reason: string) => void, private maxBytes = MAX_WS_MESSAGE_BYTES) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.fail("reserved bits set");
      if (!(b1 & 0x80)) return this.fail("client frame not masked");
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) return this.fail("frame too large");
        len = Number(big); off = 10;
      }
      if (len > this.maxBytes) return this.fail("frame too large");
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (opcode >= 8) {
        if (!fin || len > 125) return this.fail("bad control frame");
        this.onMessage(opcode, data);
        continue;
      }
      if (opcode === 0) {
        if (!this.partOpcode) return this.fail("unexpected continuation");
      } else {
        if (this.partOpcode) return this.fail("expected continuation");
        this.partOpcode = opcode;
      }
      this.partBytes += data.length;
      if (this.partBytes > this.maxBytes) return this.fail("message too large");
      this.parts.push(data);
      if (fin) {
        const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        const op = this.partOpcode;
        this.parts = []; this.partBytes = 0; this.partOpcode = 0;
        this.onMessage(op, whole);
      }
    }
  }
  private fail(reason: string) { this.buf = Buffer.alloc(0); this.onProtocolError(reason); }
}

// ---------------------------------------------------------------- CdpMux

export type CdpMsg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown>; error?: { code: number; message: string } };
export type MuxClient = { id: number; send(msg: CdpMsg): void; close(): void; /** Identifies the agent session (from the endpoint URL); used to look up its link scope. */ agent?: string };

type Pending =
  | { kind: "client"; client: MuxClient; id: number; method: string; sessionId?: string; params: Record<string, unknown> }
  | { kind: "daemon"; method: string; params: Record<string, unknown>; resolve: (r: CdpMsg) => void };

/**
 * Public CAPTCHA / bot-check frames. The daemon does not pause, intercept or probe them: a person solves these, and CDP side effects on the
 * challenge frame (a frame held at start, Fetch interception, script evaluated in the page while the pointer moves) are signals the check can see.
 * They are public hosts, so the private-network guard (T6) loses nothing; with egress on the desktop guard is the real boundary.
 */
export function isChallengeUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "challenges.cloudflare.com") return true;
  if (h === "hcaptcha.com" || h.endsWith(".hcaptcha.com")) return true;
  if (h === "recaptcha.net" || h === "www.recaptcha.net") return true;
  if (h === "www.google.com" || h === "google.com") return u.pathname === "/recaptcha" || u.pathname.startsWith("/recaptcha/");
  return false;
}

export type TargetInfo = { targetId: string; type: string; title: string; url: string; attached?: boolean; openerId?: string; browserContextId?: string };

const BLOCKED_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Browser.setPermission"]);

/** Multiplexes the daemon and any number of agent clients over one CDP pipe.
 *  Chromium sees a single browser-level connection (the daemon). Every client gets its own sessions (Target.attachToTarget with
 *  flatten:true), so Target.setAutoAttach at browser level is emulated per client. */
export class CdpMux {
  /** Egress mode: strip per-context proxy settings from Target.createBrowserContext (the route is the daemon's, not the agent's). */
  lockProxy = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private clients = new Map<number, MuxClient>();
  private autoAttach = new Set<number>();
  private discover = new Set<number>();
  private owners = new Map<string, number | "daemon">(); // sessionId -> client id | daemon
  private sessionTarget = new Map<string, string>(); // page session -> targetId (for activity)
  private contexts = new Map<number, Set<string>>(); // client -> browser contexts it created
  readonly targets = new Map<string, TargetInfo>();
  /** Page targets created through an agent client. */
  readonly agentOpened = new Set<string>();
  private daemonSessionByTarget = new Map<string, string>();
  /** Pages owned by a Browser node (the user's live view). Unscoped agents never see them: a linked agent sees exactly its node's page. */
  readonly claimed = new Set<string>();
  /** While true, the next page Chromium announces is the daemon's own node page: claimed at once. */
  reserve = false;
  reserved: string[] = [];
  /** client id -> the one targetId it is linked to (null = linked but the page is not up yet). Absent = unscoped. */
  private scopes = new Map<number, string | null>();

  /** Whether `targetId` is part of this client's world: a scoped client sees only its page, an unscoped one sees every unclaimed page. */
  visible(clientId: number, targetId: string): boolean {
    const t = this.targets.get(targetId);
    if (t && t.type !== "page") return true; // non-page targets (workers etc.) follow their page through sessions
    if (this.scopes.has(clientId)) return this.scopes.get(clientId) === targetId;
    return !this.claimed.has(targetId);
  }
  isScoped(clientId: number): boolean { return this.scopes.has(clientId); }

  /** Re-scopes a connected client and tells it what appeared and disappeared (so Playwright adopts or drops pages live). */
  setScope(clientId: number, targetId: string | null | undefined): void {
    const client = this.clients.get(clientId);
    const before = client ? this.visiblePages(clientId) : new Set<string>();
    if (targetId === undefined) this.scopes.delete(clientId); else this.scopes.set(clientId, targetId);
    if (!client) return;
    const after = this.visiblePages(clientId);
    for (const id of before) if (!after.has(id)) this.hideFrom(client, id);
    for (const id of after) if (!before.has(id)) this.showTo(client, id);
  }
  /** Claims/unclaims pages for nodes and refreshes every connected client's view. */
  setClaimed(next: Set<string>): void {
    const before = new Map([...this.clients.keys()].map((id) => [id, this.visiblePages(id)] as const));
    this.claimed.clear(); for (const id of next) this.claimed.add(id);
    for (const [cid, was] of before) {
      const client = this.clients.get(cid); if (!client) continue;
      const now = this.visiblePages(cid);
      for (const id of was) if (!now.has(id)) this.hideFrom(client, id);
      for (const id of now) if (!was.has(id)) this.showTo(client, id);
    }
  }
  private visiblePages(clientId: number): Set<string> {
    const out = new Set<string>();
    for (const t of this.targets.values()) if (t.type === "page" && this.visible(clientId, t.targetId)) out.add(t.targetId);
    return out;
  }
  private hideFrom(client: MuxClient, targetId: string) {
    for (const [sid, owner] of this.owners) if (owner === client.id && this.sessionTarget.get(sid) === targetId) {
      this.owners.delete(sid); this.sessionTarget.delete(sid);
      client.send({ method: "Target.detachedFromTarget", params: { sessionId: sid, targetId } });
      this.command("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
    }
    if (this.discover.has(client.id)) client.send({ method: "Target.targetDestroyed", params: { targetId } });
  }
  private showTo(client: MuxClient, targetId: string) {
    const info = this.targets.get(targetId); if (!info) return;
    if (this.discover.has(client.id)) client.send({ method: "Target.targetCreated", params: { targetInfo: this.infoFor(info) } });
    if (this.autoAttach.has(client.id)) void this.attachForClient(client, info);
  }

  onDaemonEvent: (msg: CdpMsg) => void = () => {};
  onTargetsChanged: () => void = () => {};
  onActivity: (targetId: string) => void = () => {};
  onClientCount: (n: number) => void = () => {};
  /** Called for every page target the daemon learned about (after it is attached by the daemon); hook for Fetch interception. */
  onDaemonAttached: (info: TargetInfo, sessionId: string) => void = () => {};

  constructor(private writeToChrome: (msg: CdpMsg) => void) {}

  get clientCount(): number { return this.clients.size; }

  /** Daemon command to Chromium (browser level or on one of the daemon's own sessions). */
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15000): Promise<CdpMsg> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.trackAttach(method, params, 1);
      const timer = setTimeout(() => { this.pending.delete(id); this.trackAttach(method, params, -1); reject(new Error("cdp timeout: " + method)); }, timeoutMs);
      this.pending.set(id, { kind: "daemon", method, params, resolve: (r) => { clearTimeout(timer); if (r.error) reject(new Error(method + ": " + r.error.message)); else resolve(r); } });
      this.writeToChrome({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  /** The daemon's own session for a page target, if attached. */
  sessionFor(targetId: string): string | undefined { return this.daemonSessionByTarget.get(targetId); }

  addClient(client: MuxClient): void {
    this.clients.set(client.id, client);
    this.onClientCount(this.clients.size);
  }

  removeClient(clientId: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    this.autoAttach.delete(clientId);
    this.discover.delete(clientId);
    this.scopes.delete(clientId);
    for (const [sid, owner] of this.owners) {
      if (owner === clientId) {
        this.owners.delete(sid);
        this.sessionTarget.delete(sid);
        this.command("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
      }
    }
    for (const k of [...this.attaching.keys()]) if (k.startsWith(clientId + ":")) this.attaching.delete(k);
    for (const ctx of this.contexts.get(clientId) ?? []) this.command("Target.disposeBrowserContext", { browserContextId: ctx }).catch(() => {});
    this.contexts.delete(clientId);
    for (const [id, p] of this.pending) if (p.kind === "client" && p.client.id === clientId) { this.pending.delete(id); this.trackAttach(p.method, p.params, -1); }
    this.onClientCount(this.clients.size);
  }

  /** A message from an agent client. */
  fromClient(client: MuxClient, raw: unknown): void {
    if (!isObject(raw) || !isInt(raw.id, 0, 2 ** 31) || typeof raw.method !== "string" || (raw.sessionId !== undefined && typeof raw.sessionId !== "string")) {
      return client.send({ id: isInt(isObject(raw) ? raw.id : undefined, 0, 2 ** 31) ? (raw as { id: number }).id : 0, error: { code: -32600, message: "invalid request" } });
    }
    const id = raw.id as number, method = raw.method, sessionId = raw.sessionId as string | undefined;
    const params = isObject(raw.params) ? raw.params : {};
    const fail = (message: string, code = -32000) => client.send({ id, ...(sessionId ? { sessionId } : {}), error: { code, message } });
    if (BLOCKED_METHODS.has(method)) return fail("not allowed on the shared browser: " + method);
    if (sessionId !== undefined) {
      if (this.owners.get(sessionId) !== client.id) return fail("Session with given id not found.");
      const tid = this.sessionTarget.get(sessionId);
      if (tid && !method.startsWith("Target.")) this.onActivity(tid);
      return this.forward(client, id, method, params, sessionId);
    }
    switch (method) {
      case "Target.setAutoAttach": {
        if (params.autoAttach === true) {
          this.autoAttach.add(client.id);
          client.send({ id, result: {} });
          for (const info of this.targets.values()) if (info.type === "page" && this.visible(client.id, info.targetId)) void this.attachForClient(client, info);
        } else {
          this.autoAttach.delete(client.id);
          client.send({ id, result: {} });
        }
        return;
      }
      case "Target.setDiscoverTargets":
        if (params.discover === true) {
          this.discover.add(client.id);
          client.send({ id, result: {} });
          for (const info of this.targets.values()) if (this.visible(client.id, info.targetId)) client.send({ method: "Target.targetCreated", params: { targetInfo: this.infoFor(info) } });
        } else { this.discover.delete(client.id); client.send({ id, result: {} }); }
        return;
      case "Target.getTargets":
        return client.send({ id, result: { targetInfos: [...this.targets.values()].filter((t) => this.visible(client.id, t.targetId)).map((t) => this.infoFor(t)) } });
      case "Target.createTarget":
        // A linked agent works in its node's page: it may not open more (the user watches exactly one page).
        if (this.isScoped(client.id)) return fail("This agent is linked to one browser page; navigate that page instead of opening a new one");
        return this.forward(client, id, method, params, undefined);
      case "Target.createBrowserContext": {
        // Egress mode: a context may not pick its own proxy ("direct://" would leave from the server, an http proxy would route through a third party).
        let p = params;
        if (this.lockProxy) { p = { ...params }; for (const k of ["proxyServer", "proxyBypassList", "proxyBypassRules"]) delete p[k]; }
        return this.forward(client, id, method, p, undefined);
      }
      case "Target.attachToTarget": case "Target.closeTarget": case "Target.activateTarget": case "Target.getTargetInfo": {
        const tid = typeof params.targetId === "string" ? params.targetId : undefined;
        if (tid && this.targets.has(tid) && !this.visible(client.id, tid)) return fail("No target with given id found");
        return this.forward(client, id, method, params, undefined);
      }
      default:
        return this.forward(client, id, method, params, undefined);
    }
  }

  /** In-flight explicit Target.attachToTarget commands per target. Chromium also reports those sessions as browser-level
   *  Target.attachedToTarget events (before the response); they belong to whoever asked, not to the daemon's own auto-attach. */
  private explicitAttach = new Map<string, number>();
  private trackAttach(method: string, params: Record<string, unknown>, delta: 1 | -1) {
    if (method !== "Target.attachToTarget" || typeof params.targetId !== "string") return;
    const n = (this.explicitAttach.get(params.targetId) ?? 0) + delta;
    if (n > 0) this.explicitAttach.set(params.targetId, n); else this.explicitAttach.delete(params.targetId);
  }

  private forward(client: MuxClient, id: number, method: string, params: Record<string, unknown>, sessionId: string | undefined) {
    const gid = this.nextId++;
    this.trackAttach(method, params, 1);
    this.pending.set(gid, { kind: "client", client, id, method, sessionId, params });
    this.writeToChrome({ id: gid, method, params, ...(sessionId ? { sessionId } : {}) });
  }

  private infoFor(t: TargetInfo) {
    return { targetId: t.targetId, type: t.type, title: t.title, url: t.url, attached: false, canAccessOpener: false, ...(t.browserContextId ? { browserContextId: t.browserContextId } : {}) };
  }

  private attaching = new Map<string, Promise<void>>();
  /** Idempotent: one session per (client, target), and callers can await it. */
  private attachForClient(client: MuxClient, info: TargetInfo): Promise<void> {
    const key = client.id + ":" + info.targetId;
    let p = this.attaching.get(key);
    if (!p) { p = this.doAttach(client, info); this.attaching.set(key, p); }
    return p;
  }

  private async doAttach(client: MuxClient, info: TargetInfo): Promise<void> {
    try {
      const r = await this.command("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      const sessionId = String(r.result?.sessionId ?? "");
      if (!sessionId) return;
      if (!this.clients.has(client.id) || !this.autoAttach.has(client.id)) { this.command("Target.detachFromTarget", { sessionId }).catch(() => {}); return; }
      this.owners.set(sessionId, client.id);
      this.sessionTarget.set(sessionId, info.targetId);
      client.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { ...this.infoFor(info), attached: true }, waitingForDebugger: false } });
    } catch { /* target went away */ }
  }

  /** A message read from Chromium. */
  fromChrome(msg: CdpMsg): void {
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.trackAttach(p.method, p.params, -1);
      if (p.kind === "daemon") return p.resolve(msg);
      const out: CdpMsg = { id: p.id, ...(msg.result !== undefined ? { result: msg.result } : {}), ...(msg.error ? { error: msg.error } : {}), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) };
      const r = msg.result;
      if (r && p.method === "Target.attachToTarget" && typeof r.sessionId === "string") this.owners.set(r.sessionId, p.client.id);
      let afterAttach: Promise<void> | undefined;
      if (r && p.method === "Target.createTarget" && typeof r.targetId === "string") {
        this.agentOpened.add(r.targetId); this.onTargetsChanged();
        // Chromium sends attachedToTarget BEFORE the createTarget response, and Playwright relies on that order: attach this client first.
        if (this.autoAttach.has(p.client.id)) {
          const info = this.targets.get(r.targetId) ?? { targetId: r.targetId, type: "page", title: "", url: "about:blank" };
          afterAttach = this.attachForClient(p.client, info);
        }
      }
      if (r && p.method === "Target.createBrowserContext" && typeof r.browserContextId === "string") {
        const set = this.contexts.get(p.client.id) ?? new Set<string>();
        set.add(r.browserContextId); this.contexts.set(p.client.id, set);
      }
      if (p.method === "Target.disposeBrowserContext" && !msg.error) this.contexts.get(p.client.id)?.clear();
      const target = this.clients.get(p.client.id);
      if (afterAttach) void afterAttach.then(() => target?.send(out));
      else target?.send(out);
      return;
    }
    if (typeof msg.method !== "string") return;
    const sid = msg.sessionId;
    if (sid) {
      const owner = this.owners.get(sid);
      if (msg.method === "Target.attachedToTarget" && typeof msg.params?.sessionId === "string" && owner !== undefined) {
        // A child target (iframe, worker) auto-attached under a session: same owner as its parent.
        this.owners.set(msg.params.sessionId, owner);
        const ti = msg.params.targetInfo as { targetId?: string } | undefined;
        if (owner !== "daemon" && ti?.targetId) this.sessionTarget.set(msg.params.sessionId, ti.targetId);
      }
      if (msg.method === "Target.detachedFromTarget" && typeof msg.params?.sessionId === "string") { this.owners.delete(msg.params.sessionId); this.sessionTarget.delete(msg.params.sessionId); }
      if (owner === "daemon") {
        // A child target (cross-origin iframe, worker) attached under the daemon's own page session is started paused
        // (waitForDebuggerOnStart): it must go through the same hook as a page, which resumes it. Without this the OOPIF
        // never loads (Cloudflare Turnstile's challenge iframe stayed an empty frame).
        if (msg.method === "Target.attachedToTarget" && typeof msg.params?.sessionId === "string" && msg.params.targetInfo) {
          this.onDaemonAttached(msg.params.targetInfo as TargetInfo, msg.params.sessionId);
          return;
        }
        return this.onDaemonEvent(msg);
      }
      if (typeof owner === "number") this.clients.get(owner)?.send(msg);
      return;
    }
    this.browserEvent(msg);
  }

  private browserEvent(msg: CdpMsg) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "Target.attachedToTarget": {
        // The daemon's own browser-level auto-attach: one session per target, owned by the daemon.
        const sessionId = String(p.sessionId ?? "");
        const info = p.targetInfo as TargetInfo | undefined;
        if (!sessionId || !info) return;
        if (p.waitingForDebugger !== true && this.explicitAttach.has(info.targetId) && !this.owners.has(sessionId)) return; // someone's explicit attach (never waiting for a debugger): the response assigns the owner
        this.owners.set(sessionId, "daemon");
        if (info.type === "page") {
          this.daemonSessionByTarget.set(info.targetId, sessionId);
          this.sessionTarget.set(sessionId, info.targetId);
        }
        this.onDaemonAttached(info, sessionId);
        return;
      }
      case "Target.detachedFromTarget": {
        const sessionId = String(p.sessionId ?? "");
        const owner = this.owners.get(sessionId);
        if (typeof owner === "number") this.clients.get(owner)?.send({ method: "Target.detachedFromTarget", params: { sessionId } });
        this.owners.delete(sessionId);
        this.sessionTarget.delete(sessionId);
        for (const [t, s] of this.daemonSessionByTarget) if (s === sessionId) this.daemonSessionByTarget.delete(t);
        return;
      }
      case "Target.targetCreated": {
        const info = p.targetInfo as TargetInfo;
        this.targets.set(info.targetId, info);
        // A page the daemon is creating for a Browser node is claimed before anyone can see it.
        if (this.reserve && info.type === "page") { this.claimed.add(info.targetId); this.reserved.push(info.targetId); }
        this.broadcastDiscovery(msg);
        if (info.type === "page") for (const cid of this.autoAttach) { const c = this.clients.get(cid); if (c && this.visible(cid, info.targetId)) void this.attachForClient(c, info); }
        this.onTargetsChanged();
        return;
      }
      case "Target.targetInfoChanged": {
        const info = p.targetInfo as TargetInfo;
        if (this.targets.has(info.targetId)) this.targets.set(info.targetId, info);
        this.broadcastDiscovery(msg);
        this.onTargetsChanged();
        return;
      }
      case "Target.targetDestroyed": {
        const id = String(p.targetId ?? "");
        this.targets.delete(id);
        this.agentOpened.delete(id);
        this.daemonSessionByTarget.delete(id);
        this.broadcastDiscovery(msg);
        this.onTargetsChanged();
        return;
      }
      case "Target.targetCrashed": this.broadcastDiscovery(msg); this.onDaemonEvent(msg); return;
      default: this.onDaemonEvent(msg);
    }
  }

  private broadcastDiscovery(msg: CdpMsg) {
    const tid = typeof (msg.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "string" ? (msg.params!.targetInfo as { targetId: string }).targetId : typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
    for (const cid of this.discover) if (!tid || msg.method === "Target.targetDestroyed" || this.visible(cid, tid)) this.clients.get(cid)?.send({ method: msg.method, params: msg.params });
  }

  /** Close everything on shutdown. */
  closeAll(): void {
    for (const c of [...this.clients.values()]) c.close();
  }
}
