import type { ListeningPort } from "./ports.js";

/**
 * Detects app preview and debugger URLs in a session's terminal output (spec: Floq note app-debug-spec-1-preview).
 * Flutter web (`flutter run -d web-server`), the Dart VM service, Flutter DevTools and Vite-style dev servers print
 * their URL on a line of their own; we ANSI-strip the PTY output, split it into lines and match those lines.
 * Only loopback URLs are kept, and the server returns a link only while its port(s) are listening sockets of the
 * session's own process tree (see `visibleDebugLinks`), so stale or spoofed output cannot point the app elsewhere.
 */

export type DebugLinkKind = "preview" | "devtools" | "vm-service";

export interface DebugLink {
  kind: DebugLinkKind;
  url: string;
  /** Port to forward and open; local port == remote port. */
  port: number;
  /** Other ports the link needs forwarded too (DevTools talks to the VM service port). */
  extraPorts?: number[];
  label: string;
  detectedAt: number;
}

export const MAX_DEBUG_LINKS = 10;
const MAX_CARRY = 4096;
const WRAP_WAIT_MS = 1000;
const MAX_URL = 2048;
const URL_RE = "(https?://[^\\s\"'<>`]+)";
/** A long line (likely hit the terminal width) that ends inside a URL. */
const WRAPPED_URL_END = /^.{60,}https?:\/\/[^\s"'<>`]+$/;
/** A wrapped URL tail: one token of URL characters, nothing else on the line. */
const CONTINUATION = /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]{1,1024}$/;

interface Rule {
  kind: DebugLinkKind;
  label: string;
  re: RegExp;
}

// Order matters: the DevTools and VM service lines also say "is available at", so they come first.
const RULES: readonly Rule[] = [
  { kind: "devtools", label: "Flutter DevTools", re: new RegExp("Flutter DevTools debugger and profiler on .*? is available at:?\\s*" + URL_RE) },
  { kind: "vm-service", label: "Dart VM service", re: new RegExp("(?:Dart VM [Ss]ervice|Observatory debugger and profiler) on .*? is available at:?\\s*" + URL_RE) },
  { kind: "preview", label: "Flutter web app", re: new RegExp("is being served at\\s+" + URL_RE) },
  // Vite (Tauri's default frontend), and other dev servers that print the same "Local:" line (Astro, SvelteKit, Nuxt).
  { kind: "preview", label: "Dev server", re: new RegExp("(?:^|\\s)Local:\\s+" + URL_RE) },
];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "[::]"]);

/** Remove terminal escape sequences. Cursor movement becomes a line break or spaces so words from different redraws do not merge. */
export function stripAnsi(text: string): string {
  return text
    // OSC (titles, hyperlinks): ESC ] ... BEL | ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\[[0-?]*[ -/]*[ABEFGHJdf]/g, "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function cleanUrl(raw: string): URL | null {
  const trimmed = raw.replace(/[.,;:)\]}>]+$/, "");
  if (trimmed.length > MAX_URL) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  if (!LOOPBACK.has(url.hostname)) return null;
  // Always 127.0.0.1: the desktop forward listens on IPv4 loopback only, and "localhost" may resolve to ::1 there.
  url.hostname = "127.0.0.1";
  if (!url.port) return null; // dev servers always print an explicit port; 80/443 are never ours to forward
  return url;
}

function portOf(url: URL): number {
  return Number.parseInt(url.port, 10);
}

/** Match one ANSI-stripped line. Exported for tests. */
export function matchDebugLine(line: string, now = Date.now()): DebugLink | null {
  for (const rule of RULES) {
    const m = rule.re.exec(line);
    if (!m) continue;
    const url = cleanUrl(m[1]);
    if (!url) return null;
    const link: DebugLink = { kind: rule.kind, url: url.toString(), port: portOf(url), label: rule.label, detectedAt: now };
    if (rule.kind === "devtools") {
      const inner = url.searchParams.get("uri");
      const vm = inner ? cleanUrl(inner.replace(/^wss?:/, "http:")) : null;
      if (vm && portOf(vm) !== link.port) link.extraPorts = [portOf(vm)];
    }
    return link;
  }
  return null;
}

/** Per-session tracker fed with raw PTY output. */
export class DebugLinkTracker {
  private carry = "";
  /** A complete line ending in a URL that may continue on the next line; matched as-is once it is WRAP_WAIT_MS old. */
  private pending: { line: string; at: number } | null = null;
  private readonly found: DebugLink[] = [];

  feed(data: string, now = Date.now()): void {
    const held = this.pending;
    this.pending = null;
    const text = (held ? held.line + "\n" : "") + this.carry + stripAnsi(data);
    const lines = text.split("\n");
    const rest = lines.pop() ?? "";
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!line.includes("http")) continue;
      // The held line keeps the time it was first seen.
      const seenAt = held && i === 0 ? held.at : now;
      if (WRAPPED_URL_END.test(line)) {
        // A TUI (Claude Code, Codex) hard-wraps a long URL onto the next line. Wait for that line, then join.
        if (i === lines.length - 1) {
          this.pending = { line, at: seenAt };
          break;
        }
        const next = lines[i + 1].trim();
        if (CONTINUATION.test(next)) { line += next; i++; }
      }
      const link = matchDebugLine(line, seenAt);
      if (link) this.add(link);
    }
    this.carry = rest.length > MAX_CARRY ? "" : rest;
  }

  private add(link: DebugLink): void {
    if (this.found.some((item) => item.url === link.url)) return;
    this.found.push(link);
    if (this.found.length > MAX_DEBUG_LINKS) this.found.splice(0, this.found.length - MAX_DEBUG_LINKS);
  }

  links(now = Date.now()): DebugLink[] {
    if (this.pending && now - this.pending.at >= WRAP_WAIT_MS) {
      const link = matchDebugLine(this.pending.line, this.pending.at);
      if (link) this.add(link);
      this.pending = null;
    }
    return this.found.map((link) => ({ ...link, ...(link.extraPorts ? { extraPorts: [...link.extraPorts] } : {}) }));
  }

  clear(): void {
    this.carry = "";
    this.pending = null;
    this.found.length = 0;
  }
}

/** Links whose port (and extra ports) the session is listening on right now; newest first. */
export function visibleDebugLinks(links: readonly DebugLink[], ports: readonly ListeningPort[]): DebugLink[] {
  const open = new Set(ports.map((item) => item.port));
  return links
    .filter((link) => open.has(link.port) && (link.extraPorts ?? []).every((port) => open.has(port)))
    .sort((a, b) => b.detectedAt - a.detectedAt);
}
