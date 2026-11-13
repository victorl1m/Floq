import { randomBytes } from "node:crypto";
import { badRequest, notFound } from "./errors.js";
import { log } from "./logger.js";
import type { BrowserService } from "./browser.js";
import { ImportError, cookieHost, groupDomains, parseImport, type Bookmark, type ImportCookie, type ImportFormat } from "./browserImportParse.js";

/**
 * Cookie and data import for the agent browser (docs/design/agent-browser.md §A.13).
 *
 * preview(): parse the uploaded text, keep ONLY the parsed result in memory (per user, 10 min, single use) and answer with
 * domains and counts. commit(): drop that stored upload and apply the chosen cookies through CDP from a helper process
 * INSIDE the user's sandbox, fed over stdin. list/remove read and clear the live profile by domain; values are never returned.
 * Nothing here logs file text or cookie data; only counts.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 3;
const PLAYWRIGHT_CORE = "/opt/floq/playwright-mcp/package.json";

/** Runs inside the user's sandbox with `node -e`. stdin: one JSON object. stdout: one JSON object of counts. */
export const HELPER_SCRIPT = `
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
let raw = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", async () => {
  const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };
  try {
    const req = JSON.parse(raw);
    const home = process.env.HOME || ".";
    const dir = path.join(home, ".floq", "browser");
    if (req.mode === "bookmarks-count") { try { out({ bookmarks: JSON.parse(fs.readFileSync(path.join(dir, "bookmarks.json"), "utf8")).length }); } catch { out({ bookmarks: 0 }); } return; }
    if (req.mode === "bookmarks-write") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, "bookmarks.json"), tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(req.bookmarks), { mode: 0o600 }); fs.renameSync(tmp, file);
      return out({ bookmarks: req.bookmarks.length });
    }
    const { chromium } = createRequire(${JSON.stringify(PLAYWRIGHT_CORE)})("playwright-core");
    const browser = await chromium.connectOverCDP(req.endpoint, { headers: { Authorization: "Bearer " + req.token } });
    try {
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error("no browser context");
      if (req.mode === "import") {
        let imported = 0, failed = 0;
        try { await ctx.addCookies(req.cookies); imported = req.cookies.length; }
        catch { for (const c of req.cookies) { try { await ctx.addCookies([c]); imported++; } catch { failed++; } } }
        return out({ imported, failed });
      }
      if (req.mode === "list") {
        const m = new Map();
        for (const c of await ctx.cookies()) { const h = c.domain.replace(/^\\./, ""); m.set(h, (m.get(h) || 0) + 1); }
        return out({ domains: [...m].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain)) });
      }
      if (req.mode === "remove") {
        const before = (await ctx.cookies()).length;
        for (const d of [req.domain, "." + req.domain]) await ctx.clearCookies({ domain: d });
        return out({ removed: before - (await ctx.cookies()).length });
      }
      throw new Error("bad mode");
    } finally { await browser.close().catch(() => {}); }
  } catch (e) { out({ error: String((e && e.message) || e).slice(0, 120) }); process.exitCode = 1; }
});
`;

interface Pending { at: number; format: ImportFormat; cookies: ImportCookie[]; bookmarks: Bookmark[] }
export interface ImportPreview {
  importId: string;
  format: ImportFormat;
  cookies: { total: number; domains: Array<{ domain: string; count: number }>; expired: number; malformed: number };
  bookmarks: { count: number };
  skippedStorage: boolean;
}
export interface ImportResult { imported: number; failed: number; bookmarks: number }

export class BrowserImportService {
  private readonly pending = new Map<string, Map<string, Pending>>();
  constructor(private readonly browser: BrowserService, private readonly now: () => number = Date.now) {}

  private sweep(userId: string): Map<string, Pending> {
    let m = this.pending.get(userId);
    if (!m) { m = new Map(); this.pending.set(userId, m); }
    for (const [id, p] of m) if (this.now() - p.at > TTL_MS) m.delete(id);
    return m;
  }

  preview(userId: string, content: unknown): ImportPreview {
    if (typeof content !== "string" || !content) throw badRequest("Send the file text as {content}", "invalid_import");
    let parsed;
    try { parsed = parseImport(content, this.now() / 1000); }
    catch (e) { if (e instanceof ImportError) throw badRequest(e.message, e.code); throw e; }
    const mine = this.sweep(userId);
    while (mine.size >= MAX_PENDING) mine.delete(mine.keys().next().value as string);
    const importId = randomBytes(16).toString("hex");
    mine.set(importId, { at: this.now(), format: parsed.format, cookies: parsed.cookies, bookmarks: parsed.bookmarks });
    log.info("browser.import_preview", { userId, format: parsed.format, cookies: parsed.cookies.length, bookmarks: parsed.bookmarks.length });
    return {
      importId, format: parsed.format,
      cookies: { total: parsed.cookies.length, domains: groupDomains(parsed.cookies), expired: parsed.expired, malformed: parsed.malformed },
      bookmarks: { count: parsed.bookmarks.length },
      skippedStorage: parsed.skippedStorage,
    };
  }

  async commit(userId: string, input: { importId?: unknown; domains?: unknown; bookmarks?: unknown }): Promise<ImportResult> {
    await this.browser.assertAllowed(userId);
    const mine = this.sweep(userId);
    const id = typeof input.importId === "string" ? input.importId : "";
    const p = mine.get(id);
    if (!p) throw notFound("That import expired. Choose the file again.");
    if (!Array.isArray(input.domains) || input.domains.some((d) => typeof d !== "string")) throw badRequest("domains must be a list of domain names", "invalid_import");
    // The upload is single use: gone from memory whatever happens next.
    mine.delete(id);
    const chosen = new Set((input.domains as string[]).map((d) => d.toLowerCase().replace(/^\./, "")));
    const cookies = p.cookies.filter((c) => chosen.has(cookieHost(c)));
    const bookmarks = input.bookmarks === true ? p.bookmarks : [];
    if (!cookies.length && !bookmarks.length) throw badRequest("Select at least one domain or the bookmarks", "nothing_selected");
    let imported = 0, failed = 0, savedBookmarks = 0;
    if (cookies.length) {
      const e = await this.browser.ensure(userId, { wake: true });
      const r = await this.helper(userId, { mode: "import", endpoint: e.wsEndpoint, token: e.token, cookies });
      imported = Number(r.imported) || 0; failed = Number(r.failed) || 0;
    }
    if (bookmarks.length) savedBookmarks = Number((await this.helper(userId, { mode: "bookmarks-write", bookmarks })).bookmarks) || 0;
    log.info("browser.import_done", { userId, imported, failed, bookmarks: savedBookmarks });
    return { imported, failed, bookmarks: savedBookmarks };
  }

  /** Imported/known cookie domains (names and counts only) plus the stored bookmark count. */
  async list(userId: string): Promise<{ domains: Array<{ domain: string; count: number }>; bookmarks: number }> {
    await this.browser.assertAllowed(userId);
    const bookmarks = Number((await this.helper(userId, { mode: "bookmarks-count" }).catch(() => ({ bookmarks: 0 }))).bookmarks) || 0;
    if ((await this.browser.state(userId)) !== "running") return { domains: [], bookmarks };
    const e = await this.browser.ensure(userId);
    const r = await this.helper(userId, { mode: "list", endpoint: e.wsEndpoint, token: e.token });
    return { domains: Array.isArray(r.domains) ? (r.domains as Array<{ domain: string; count: number }>) : [], bookmarks };
  }

  async removeDomain(userId: string, domain: unknown): Promise<{ removed: number }> {
    await this.browser.assertAllowed(userId);
    if (typeof domain !== "string" || !/^[a-z0-9.-]{1,253}$/i.test(domain)) throw badRequest("domain must be a host name", "invalid_domain");
    const e = await this.browser.ensure(userId, { wake: true });
    const r = await this.helper(userId, { mode: "remove", endpoint: e.wsEndpoint, token: e.token, domain: domain.toLowerCase().replace(/^\./, "") });
    log.info("browser.domain_removed", { userId, removed: Number(r.removed) || 0 });
    return { removed: Number(r.removed) || 0 };
  }

  private async helper(userId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.browser.runHelper(userId, HELPER_SCRIPT, JSON.stringify(input));
    if (r.code !== 0 || r.out.error) { log.warn("browser.import_helper_failed", { userId, mode: String(input.mode), code: r.code }); throw badRequest("The browser could not apply that change", "browser_import_failed"); }
    return r.out;
  }
}
