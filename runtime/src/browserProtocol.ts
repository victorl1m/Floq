/**
 * Agent browser wire rules (docs/design/agent-browser.md §A.5), pure and dependency free.
 *
 * - `validateClientMessage`: app -> runtime. Only an allowlisted set of messages, rebuilt field by field, so the app can
 *   never smuggle raw CDP or an unknown field through to the daemon. `hello`, `frame.ack` and `shutdown` are runtime-only.
 * - `toViewerMessage`: daemon -> app. Same idea in the other direction; `ready` (which carries the token) and `exit` never reach a viewer.
 * - `JsonLines`: the JSON-line codec for the daemon pipe, with a hard line cap.
 * - `RateWindow`: the per-socket input rate limit.
 * The daemon validates again on its own side (runtime/image/floq-browserd-core.mts); this is the first gate, not the only one.
 */

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 4096;
export const MAX_URL_CHARS = 2048;
export const MAX_FRAME_W = 1600;
export const MAX_FRAME_H = 1200;
export const INPUT_PER_SECOND = 120;
export const MAX_TABS_REPORTED = 64;

export type MouseKind = "mousePressed" | "mouseReleased" | "mouseMoved";
export type ClientMessage =
  | { type: "screencast.start"; targetId: string; maxW: number; maxH: number; quality: number }
  | { type: "screencast.stop" }
  | { type: "input.mouse"; kind: MouseKind; x: number; y: number; button: "none" | "left" | "middle" | "right"; clickCount: number; modifiers: number }
  | { type: "input.wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "input.key"; kind: "keyDown" | "keyUp"; key: string; code: string; text?: string; modifiers: number }
  | { type: "input.text"; text: string }
  | { type: "nav.go"; targetId?: string; url: string }
  | { type: "nav.back" } | { type: "nav.forward" } | { type: "nav.reload" } | { type: "nav.stop" }
  | { type: "tab.new"; url?: string }
  | { type: "tab.close"; targetId: string }
  | { type: "tab.select"; targetId: string };
export type ClientValidation = { ok: true; msg: ClientMessage } | { ok: false; code: string };

const bad = (code = "bad_message"): { ok: false; code: string } => ({ ok: false, code });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[A-Za-z0-9_]{0,32}$/;
const COORD_LIMIT = 16384;
const WHEEL_LIMIT = 10000;
const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const int = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

const NAMED_KEYS = new Set([
  "Backspace", "Tab", "Enter", "Escape", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Shift", "Control", "Alt", "Meta", "CapsLock", "ContextMenu", "Dead", "Unidentified", "NumLock", "ScrollLock", "Pause", "PrintScreen",
]);
/** One user-perceived character (any single code point, but no control characters) or a named key. */
export function isAllowedKey(key: unknown): key is string {
  if (typeof key !== "string" || key === "") return false;
  if (NAMED_KEYS.has(key) || /^F([1-9]|1\d|2[0-4])$/.test(key)) return true;
  const points = [...key];
  if (points.length !== 1) return false;
  const cp = points[0].codePointAt(0)!;
  return !(cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) && !(cp >= 0xd800 && cp <= 0xdfff);
}

/**
 * http(s) and the exact `about:blank` only. Returns the normalized URL (what the browser would parse), or null.
 * No whitespace or control characters anywhere (this also stops `java\nscript:` style tricks), no credentials-free requirement:
 * a user may type a URL with a port or path, but never another scheme.
 */
export function normalizeNavUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  if (raw === "about:blank") return raw;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029\u200b-\u200f\ufeff]/.test(raw)) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  return url.href;
}

export function validateClientMessage(input: unknown): ClientValidation {
  if (!isObject(input) || typeof input.type !== "string") return bad();
  const m = input;
  switch (m.type) {
    case "screencast.start": {
      if (typeof m.targetId !== "string" || !TARGET_ID.test(m.targetId)) return bad();
      const w = num(m.maxW, 1, 1e6), h = num(m.maxH, 1, 1e6), q = num(m.quality, 1, 100);
      if (w === null || h === null || q === null) return bad();
      return { ok: true, msg: { type: "screencast.start", targetId: m.targetId, maxW: Math.min(MAX_FRAME_W, Math.round(w)), maxH: Math.min(MAX_FRAME_H, Math.round(h)), quality: Math.round(q) } };
    }
    case "screencast.stop": return { ok: true, msg: { type: "screencast.stop" } };
    case "input.mouse": {
      if (m.kind !== "mousePressed" && m.kind !== "mouseReleased" && m.kind !== "mouseMoved") return bad();
      if (m.button !== "none" && m.button !== "left" && m.button !== "middle" && m.button !== "right") return bad();
      const x = num(m.x, 0, COORD_LIMIT), y = num(m.y, 0, COORD_LIMIT), clickCount = int(m.clickCount, 0, 3), modifiers = int(m.modifiers ?? 0, 0, 15);
      if (x === null || y === null || clickCount === null || modifiers === null) return bad();
      return { ok: true, msg: { type: "input.mouse", kind: m.kind, x, y, button: m.button, clickCount, modifiers } };
    }
    case "input.wheel": {
      const x = num(m.x, 0, COORD_LIMIT), y = num(m.y, 0, COORD_LIMIT), dx = num(m.dx, -WHEEL_LIMIT, WHEEL_LIMIT), dy = num(m.dy, -WHEEL_LIMIT, WHEEL_LIMIT);
      if (x === null || y === null || dx === null || dy === null) return bad();
      return { ok: true, msg: { type: "input.wheel", x, y, dx, dy } };
    }
    case "input.key": {
      if (m.kind !== "keyDown" && m.kind !== "keyUp") return bad();
      if (!isAllowedKey(m.key)) return bad();
      if (typeof m.code !== "string" || !CODE.test(m.code)) return bad();
      const modifiers = int(m.modifiers ?? 0, 0, 15);
      if (modifiers === null) return bad();
      let text: string | undefined;
      if (m.text !== undefined) {
        if (typeof m.text !== "string" || [...m.text].length > 8 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(m.text)) return bad();
        text = m.text;
      }
      return { ok: true, msg: { type: "input.key", kind: m.kind, key: m.key, code: m.code, ...(text !== undefined ? { text } : {}), modifiers } };
    }
    case "input.text": {
      if (typeof m.text !== "string" || m.text.includes("\u0000") || Buffer.byteLength(m.text, "utf8") > MAX_TEXT_BYTES) return bad();
      return { ok: true, msg: { type: "input.text", text: m.text } };
    }
    case "nav.go": {
      const url = normalizeNavUrl(m.url);
      if (url === null) return bad("bad_url");
      if (m.targetId !== undefined && (typeof m.targetId !== "string" || !TARGET_ID.test(m.targetId))) return bad();
      return { ok: true, msg: { type: "nav.go", ...(m.targetId !== undefined ? { targetId: m.targetId as string } : {}), url } };
    }
    case "nav.back": case "nav.forward": case "nav.reload": case "nav.stop":
      return { ok: true, msg: { type: m.type } };
    case "tab.new": {
      if (m.url === undefined) return { ok: true, msg: { type: "tab.new" } };
      const url = normalizeNavUrl(m.url);
      return url === null ? bad("bad_url") : { ok: true, msg: { type: "tab.new", url } };
    }
    case "tab.close": case "tab.select":
      return typeof m.targetId === "string" && TARGET_ID.test(m.targetId) ? { ok: true, msg: { type: m.type, targetId: m.targetId } } : bad();
    default: return bad();
  }
}

// ---------------------------------------------------------------- daemon -> app

export type ViewerMessage =
  | { type: "state"; state: "starting" | "running" | "stopped" | "disabled" | "unavailable" }
  | { type: "frame"; n: number; targetId: string; jpeg: string; w: number; h: number; scale: number }
  | { type: "tabs"; tabs: Array<{ targetId: string; title: string; url: string; opener: "agent" | "user" }> }
  | { type: "nav"; targetId: string; url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean }
  | { type: "agentActivity"; targetId: string; at: number }
  | { type: "clients"; agents: number }
  | { type: "error"; code: string };

const str = (v: unknown, max: number): string | null => (typeof v === "string" ? (v.length > max ? v.slice(0, max) : v) : null);
const target = (v: unknown): string | null => (typeof v === "string" && TARGET_ID.test(v) ? v : null);

/** Rebuilds a daemon message into the app's shape; null for anything that is not for viewers (ready, exit, unknown, malformed). */
export function toViewerMessage(raw: unknown): ViewerMessage | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "frame": {
      const targetId = target(raw.targetId), n = int(raw.n, 0, Number.MAX_SAFE_INTEGER), w = num(raw.w, 1, 16384), h = num(raw.h, 1, 16384), scale = num(raw.scale, 0.01, 64);
      if (!targetId || n === null || typeof raw.jpeg !== "string" || w === null || h === null || scale === null) return null;
      return { type: "frame", n, targetId, jpeg: raw.jpeg, w, h, scale };
    }
    case "tabs": {
      if (!Array.isArray(raw.tabs)) return null;
      const tabs: Array<{ targetId: string; title: string; url: string; opener: "agent" | "user" }> = [];
      for (const t of raw.tabs.slice(0, MAX_TABS_REPORTED)) {
        if (!isObject(t)) continue;
        const targetId = target(t.targetId);
        if (!targetId) continue;
        tabs.push({ targetId, title: str(t.title, 300) ?? "", url: str(t.url, MAX_URL_CHARS) ?? "", opener: t.opener === "agent" ? "agent" : "user" });
      }
      return { type: "tabs", tabs };
    }
    case "nav": {
      const targetId = target(raw.targetId);
      if (!targetId) return null;
      return { type: "nav", targetId, url: str(raw.url, MAX_URL_CHARS) ?? "", title: str(raw.title, 300) ?? "", loading: raw.loading === true, canBack: raw.canBack === true, canForward: raw.canForward === true };
    }
    case "agentActivity": {
      const targetId = target(raw.targetId), at = num(raw.at, 0, Number.MAX_SAFE_INTEGER);
      return targetId && at !== null ? { type: "agentActivity", targetId, at } : null;
    }
    case "clients": {
      const agents = int(raw.agents, 0, 1e6);
      return agents === null ? null : { type: "clients", agents };
    }
    case "error": return { type: "error", code: /^[a-z_]{1,40}$/.test(String(raw.code)) ? String(raw.code) : "failed" };
    default: return null;
  }
}

// ---------------------------------------------------------------- codec and rate limit

/** Splits a byte stream into newline-terminated lines. A line over `maxBytes` is dropped (`onOverflow`), never buffered without bound. */
export class JsonLines {
  private buffer = "";
  private skipping = false;
  constructor(private readonly onLine: (line: string) => void, private readonly onOverflow: () => void = () => undefined, private readonly maxBytes = MAX_LINE_BYTES) {}

  push(chunk: Buffer | string): void {
    let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (text.length) {
      const nl = text.indexOf("\n");
      const piece = nl === -1 ? text : text.slice(0, nl);
      text = nl === -1 ? "" : text.slice(nl + 1);
      if (!this.skipping) {
        this.buffer += piece;
        // UTF-16 length is a lower bound on the byte length divided by 3; check bytes only when the cheap bound could be exceeded.
        if (this.buffer.length * 3 > this.maxBytes && Buffer.byteLength(this.buffer, "utf8") > this.maxBytes) { this.buffer = ""; this.skipping = true; this.onOverflow(); }
      }
      if (nl === -1) break;
      if (this.skipping) this.skipping = false;
      else { const line = this.buffer; this.buffer = ""; if (line.trim()) this.onLine(line); }
    }
  }
}

export const encodeLine = (msg: unknown): string => JSON.stringify(msg) + "\n";

/** Fixed one-second window counter: `allow()` is false once `limit` calls were made inside the current window. */
export class RateWindow {
  private start = 0;
  private count = 0;
  constructor(private readonly limit = INPUT_PER_SECOND, private readonly windowMs = 1000, private readonly now: () => number = Date.now) {}
  allow(): boolean {
    const t = this.now();
    if (t - this.start >= this.windowMs) { this.start = t; this.count = 0; }
    return ++this.count <= this.limit;
  }
}
