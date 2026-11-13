/**
 * Cookie / bookmark file parsers for the browser import (docs/design/agent-browser.md §A.13). Pure: no I/O, no logging.
 * Nothing here ever includes a cookie value or file text in an error, because callers surface counts only.
 */

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_BOOKMARK_CHARS = 1024 * 1024;
export const MAX_COOKIES = 5000;
export const MAX_BOOKMARKS = 20000;
const MAX_FIELD = 4096;

export type SameSite = "Strict" | "Lax" | "None";
export interface ImportCookie {
  name: string;
  value: string;
  /** Leading dot = domain cookie; no dot = host-only. */
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: SameSite;
}
export interface Bookmark { title: string; url: string; folder: string }
export type ImportFormat = "netscape" | "json" | "bookmarks";
export interface ParsedImport {
  format: ImportFormat;
  cookies: ImportCookie[];
  bookmarks: Bookmark[];
  expired: number;
  malformed: number;
  /** True when the file carried localStorage (JSON `origins`) that is not imported. */
  skippedStorage: boolean;
}

export class ImportError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function detectFormat(text: string): ImportFormat {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("[") || t.startsWith("{")) return "json";
  if (/<!doctype\s+netscape-bookmark|<dt>\s*<a\s|<h3[\s>]/i.test(t.slice(0, 4096)) || /<a\s+[^>]*href=/i.test(t.slice(0, 8192))) return "bookmarks";
  return "netscape";
}

/** Returns null for an unacceptable cookie (counted as malformed by the caller). */
function normalize(c: { name: unknown; value: unknown; domain: unknown; hostOnly?: boolean; path: unknown; expires: number; httpOnly: boolean; secure: boolean; sameSite?: SameSite }, now: number): ImportCookie | "expired" | null {
  if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") return null;
  const name = c.name;
  if (!name || name.length > MAX_FIELD || c.value.length > MAX_FIELD || CONTROL.test(name) || CONTROL.test(c.value) || /[=;,\s]/.test(name)) return null;
  let host = c.domain.trim().toLowerCase();
  const dotted = host.startsWith(".");
  if (dotted) host = host.slice(1);
  if (!host || host.length > 253 || !HOST.test(host)) return null;
  const hostOnly = c.hostOnly !== undefined ? c.hostOnly : !dotted;
  const path = typeof c.path === "string" && c.path ? c.path : "/";
  if (!path.startsWith("/") || path.length > MAX_FIELD || CONTROL.test(path) || path.includes(";")) return null;
  if (c.expires > 0 && c.expires <= now) return "expired";
  const expires = c.expires > 0 ? Math.floor(c.expires) : -1;
  const lower = name.toLowerCase();
  if (lower.startsWith("__host-") && !(c.secure && path === "/" && hostOnly)) return null;
  if (lower.startsWith("__secure-") && !c.secure) return null;
  let sameSite = c.sameSite;
  if (sameSite === "None" && !c.secure) sameSite = undefined; // Chromium rejects SameSite=None without Secure
  const out: ImportCookie = { name, value: c.value, domain: hostOnly ? host : "." + host, path, expires, httpOnly: c.httpOnly, secure: c.secure };
  if (sameSite) out.sameSite = sameSite;
  return out;
}

export function parseNetscape(text: string, now = Date.now() / 1000): ParsedImport {
  const res: ParsedImport = { format: "netscape", cookies: [], bookmarks: [], expired: 0, malformed: 0, skippedStorage: false };
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    let line = raw;
    if (!line.trim()) continue;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) { httpOnly = true; line = line.slice("#HttpOnly_".length); }
    else if (line.trimStart().startsWith("#")) continue;
    let f = line.split("\t");
    if (f.length !== 7) { const w = line.trim().split(/\s+/); if (w.length === 7) f = w; else { res.malformed++; continue; } }
    const [domain, sub, path, secure, expiresRaw, name, value] = f;
    const isBool = (s: string) => s === "TRUE" || s === "FALSE";
    const exp = Number(expiresRaw);
    if (!isBool(sub.toUpperCase()) || !isBool(secure.toUpperCase()) || !Number.isFinite(exp) || exp < 0) { res.malformed++; continue; }
    const includeSub = sub.toUpperCase() === "TRUE";
    if (res.cookies.length >= MAX_COOKIES) throw new ImportError("Too many cookies in this file", "too_many");
    // Some exporters write milliseconds; treat clearly-too-large values as such.
    const expires = exp > 1e11 ? exp / 1000 : exp;
    const n = normalize({ name, value, domain, hostOnly: !includeSub, path, expires, httpOnly, secure: secure.toUpperCase() === "TRUE" }, now);
    if (n === "expired") res.expired++; else if (!n) res.malformed++; else res.cookies.push(n);
  }
  return res;
}

const SAMESITE: Record<string, SameSite | undefined> = { strict: "Strict", lax: "Lax", none: "None", no_restriction: "None", unspecified: undefined };

export function parseJsonCookies(text: string, now = Date.now() / 1000): ParsedImport {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new ImportError("That file is not valid JSON", "invalid_json"); }
  const res: ParsedImport = { format: "json", cookies: [], bookmarks: [], expired: 0, malformed: 0, skippedStorage: false };
  let list: unknown;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    list = o.cookies;
    if (Array.isArray(o.origins) && o.origins.some((x) => x && typeof x === "object" && Array.isArray((x as { localStorage?: unknown }).localStorage) && (x as { localStorage: unknown[] }).localStorage.length)) res.skippedStorage = true;
  }
  if (!Array.isArray(list)) throw new ImportError("No cookie list found in that JSON", "no_cookies");
  for (const item of list) {
    if (!item || typeof item !== "object") { res.malformed++; continue; }
    const o = item as Record<string, unknown>;
    if (res.cookies.length >= MAX_COOKIES) throw new ImportError("Too many cookies in this file", "too_many");
    const expRaw = o.expirationDate ?? o.expires ?? o.expiry;
    const session = o.session === true;
    let expires = session || expRaw === undefined || expRaw === null ? -1 : Number(expRaw);
    if (!Number.isFinite(expires)) { res.malformed++; continue; }
    if (expires > 1e11) expires /= 1000;
    const ss = typeof o.sameSite === "string" ? SAMESITE[o.sameSite.toLowerCase()] : undefined;
    const n = normalize({
      name: o.name, value: o.value, domain: o.domain ?? o.host,
      hostOnly: typeof o.hostOnly === "boolean" ? o.hostOnly : undefined,
      path: o.path, expires, httpOnly: o.httpOnly === true, secure: o.secure === true, sameSite: ss,
    }, now);
    if (n === "expired") res.expired++; else if (!n) res.malformed++; else res.cookies.push(n);
  }
  return res;
}

/** Netscape bookmark HTML: <H3> opens a folder, <A HREF> is an entry, </DL> closes a folder level. */
export function parseBookmarksHtml(text: string): ParsedImport {
  const res: ParsedImport = { format: "bookmarks", cookies: [], bookmarks: [], expired: 0, malformed: 0, skippedStorage: false };
  if (text.length > MAX_BOOKMARK_CHARS) throw new ImportError("That bookmarks file is too large (limit 1 MB)", "too_large");
  const stack: string[] = [];
  let pending: string | null = null;
  const decode = (s: string) => s.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/<[^>]*>/g, "").trim();
  // Linear scanner: every tag and text span is length-bounded, so unclosed openers can never rescan to EOF.
  const MAX_TAG = 4096, MAX_TEXT = 2048;
  let lower = text.toLowerCase();
  if (lower.length !== text.length) lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  // next(): indexOf with a memo, so a run of openers that never close costs one scan in total, not one per opener.
  const memo = new Map<string, number>();
  const next = (needle: string, from: number): number => {
    const cached = memo.get(needle);
    if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
    const i = lower.indexOf(needle, from);
    memo.set(needle, i);
    return i;
  };
  const closeAt = (from: number, closer: string): number => {
    const i = next(closer, from);
    return i >= 0 && i - from <= MAX_TEXT ? i : -1;
  };
  const addAnchor = (attrs: string, title: string) => {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const url = decode(href?.[1] ?? href?.[2] ?? "");
    if (!/^https?:\/\//i.test(url) || url.length > 2048 || CONTROL.test(url)) { res.malformed++; return; }
    if (res.bookmarks.length >= MAX_BOOKMARKS) throw new ImportError("Too many bookmarks in this file", "too_many");
    res.bookmarks.push({ title: decode(title).slice(0, 200) || url, url, folder: stack.filter(Boolean).join(" / ").slice(0, 300) });
  };
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;
    pos = lt + 1;
    const head = lower.slice(lt, lt + 4);
    const isA = /^<a\s/.test(head), isH3 = head === "<h3>" || /^<h3[\s>]/.test(head);
    const isDl = /^<dl[\s>]/.test(head), isEndDl = head === "</dl";
    if (!isA && !isH3 && !isDl && !isEndDl) continue;
    const gtAt = next(">", lt);
    if (gtAt < 0 || gtAt - lt >= MAX_TAG) { if (isA) res.malformed++; continue; }
    const gt = gtAt - lt;
    const tagEnd = gtAt + 1;
    if (isDl) { stack.push(pending ?? ""); pending = null; pos = tagEnd; continue; }
    if (isEndDl) { stack.pop(); pos = tagEnd; continue; }
    const close = closeAt(tagEnd, isA ? "</a>" : "</h3>");
    if (close < 0) { if (isA) res.malformed++; pos = tagEnd; continue; }
    const inner = text.slice(tagEnd, close);
    if (isH3) pending = decode(inner).slice(0, 120);
    else addAnchor(text.slice(lt + 2, lt + gt), inner);
    pos = close + 4;
  }
  return res;
}

export function parseImport(text: string, now = Date.now() / 1000): ParsedImport {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw new ImportError("That file is too large (limit 5 MB)", "too_large");
  const format = detectFormat(text);
  const r = format === "json" ? parseJsonCookies(text, now) : format === "bookmarks" ? parseBookmarksHtml(text) : parseNetscape(text, now);
  if (!r.cookies.length && !r.bookmarks.length) throw new ImportError(r.expired ? "Every cookie in that file has expired" : "Nothing importable found in that file", "empty");
  return r;
}

/** Display/selection key of a cookie: its host without the leading dot. */
export const cookieHost = (c: { domain: string }): string => c.domain.replace(/^\./, "");

export function groupDomains(cookies: ImportCookie[]): Array<{ domain: string; count: number }> {
  const m = new Map<string, number>();
  for (const c of cookies) m.set(cookieHost(c), (m.get(cookieHost(c)) ?? 0) + 1);
  return [...m].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
}
