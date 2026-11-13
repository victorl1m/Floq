import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { parseNetscape, parseJsonCookies, parseBookmarksHtml, parseImport, detectFormat, groupDomains } from "../dist/browserImportParse.js";
import { BrowserImportService, HELPER_SCRIPT } from "../dist/browserImport.js";

const NOW = 1_800_000_000;
const FUTURE = NOW + 86_400;
const T = (...f: (string | number)[]) => f.join("\t");

test("netscape: host-only vs domain, httpOnly, secure, session, expired, malformed", () => {
  const txt = [
    "# Netscape HTTP Cookie File",
    T(".example.com", "TRUE", "/", "TRUE", FUTURE, "sid", "abc"),
    T("www.example.com", "FALSE", "/app", "FALSE", 0, "host", "v"),
    "#HttpOnly_" + T(".example.com", "TRUE", "/", "TRUE", FUTURE, "auth", "tok"),
    T(".old.com", "TRUE", "/", "FALSE", NOW - 10, "gone", "x"),
    "not a cookie line",
    T(".bad.com", "MAYBE", "/", "FALSE", FUTURE, "n", "v"),
    T("bad host!", "FALSE", "/", "FALSE", FUTURE, "n", "v"),
    T(".ms.com", "TRUE", "/", "FALSE", (FUTURE) * 1000, "ms", "v"),
    "",
  ].join("\r\n");
  const r = parseNetscape(txt, NOW);
  assert.equal(r.cookies.length, 4);
  assert.equal(r.expired, 1);
  assert.equal(r.malformed, 3);
  const by = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
  assert.equal(by.sid.domain, ".example.com"); assert.equal(by.sid.secure, true); assert.equal(by.sid.httpOnly, false);
  assert.equal(by.host.domain, "www.example.com"); assert.equal(by.host.expires, -1); assert.equal(by.host.path, "/app");
  assert.equal(by.auth.httpOnly, true);
  assert.equal(by.ms.expires, FUTURE);
  assert.equal(by.sid.sameSite, undefined);
});

test("netscape: accepts space separated 7 fields, rejects negative expiry, drops control chars", () => {
  const r = parseNetscape(`.a.com TRUE / FALSE ${FUTURE} n v\n.a.com TRUE / FALSE -5 n v\n` + T(".a.com", "TRUE", "/", "FALSE", FUTURE, "n", "bad\u0001"), NOW);
  assert.equal(r.cookies.length, 1);
  assert.equal(r.malformed, 2);
});

test("json: Cookie-Editor style, sameSite mapping, hostOnly, session, expired", () => {
  const r = parseJsonCookies(JSON.stringify([
    { name: "a", value: "1", domain: ".x.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: FUTURE + 0.5 },
    { name: "b", value: "2", domain: "x.com", hostOnly: true, secure: false, sameSite: "lax", session: true },
    { name: "c", value: "3", domain: ".x.com", hostOnly: false, sameSite: "strict", expirationDate: NOW - 1 },
    { name: "d", value: "4", domain: ".x.com", sameSite: "unspecified", secure: true },
    { name: "e", value: "5", domain: ".x.com", sameSite: "None", secure: false },
    { name: "", value: "6", domain: "x.com" },
    "junk", null, { name: "f", value: 1, domain: "x.com" },
  ]), NOW);
  const by = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(by), ["a", "b", "d", "e"]);
  assert.equal(by.a.sameSite, "None"); assert.equal(by.a.httpOnly, true); assert.equal(by.a.expires, FUTURE);
  assert.equal(by.b.domain, "x.com"); assert.equal(by.b.sameSite, "Lax"); assert.equal(by.b.expires, -1);
  assert.equal(by.d.sameSite, undefined);
  assert.equal(by.e.sameSite, undefined, "SameSite=None without Secure is dropped");
  assert.equal(r.expired, 1); assert.equal(r.malformed, 4);
});

test("json: playwright storageState shape, localStorage is reported as skipped, bad json and shapes throw", () => {
  const r = parseJsonCookies(JSON.stringify({ cookies: [{ name: "a", value: "1", domain: ".x.com", path: "/", expires: -1, secure: true, httpOnly: false, sameSite: "Lax" }], origins: [{ origin: "https://x.com", localStorage: [{ name: "k", value: "v" }] }] }), NOW);
  assert.equal(r.cookies.length, 1); assert.equal(r.skippedStorage, true);
  assert.throws(() => parseJsonCookies("{nope", NOW), { code: "invalid_json" });
  assert.throws(() => parseJsonCookies('{"a":1}', NOW), { code: "no_cookies" });
});

test("cookie name prefixes are enforced", () => {
  const r = parseJsonCookies(JSON.stringify([
    { name: "__Host-a", value: "1", domain: "x.com", hostOnly: true, path: "/", secure: true },
    { name: "__Host-b", value: "1", domain: ".x.com", path: "/", secure: true },
    { name: "__Host-c", value: "1", domain: "x.com", hostOnly: true, path: "/p", secure: true },
    { name: "__Secure-d", value: "1", domain: "x.com", secure: false },
  ]), NOW);
  assert.deepEqual(r.cookies.map((c) => c.name), ["__Host-a"]);
  assert.equal(r.malformed, 3);
});

test("bookmarks html: folders, entities, non-http dropped", () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Work</H3><DL><p><DT><A HREF="https://a.com/?x=1&amp;y=2" ADD_DATE="1">A &amp; B</A><DT><H3>Sub</H3><DL><DT><A HREF="http://c.com">C</A></DL></DL><DT><A HREF="javascript:alert(1)">bad</A><DT><A HREF="https://top.com">Top</A></DL>`;
  const r = parseBookmarksHtml(html);
  assert.deepEqual(r.bookmarks.map((b) => [b.title, b.url, b.folder]), [["A & B", "https://a.com/?x=1&y=2", "Work"], ["C", "http://c.com", "Work / Sub"], ["Top", "https://top.com", ""]]);
  assert.equal(r.malformed, 1);
});

test("format detection, size and empty limits", () => {
  assert.equal(detectFormat("[]"), "json");
  assert.equal(detectFormat('<DT><A HREF="https://a.com">a</A>'), "bookmarks");
  assert.equal(detectFormat(".a.com\tTRUE"), "netscape");
  assert.throws(() => parseImport("x".repeat(5 * 1024 * 1024 + 1)), { code: "too_large" });
  assert.throws(() => parseImport("garbage"), { code: "empty" });
  assert.throws(() => parseImport(T(".a.com", "TRUE", "/", "FALSE", NOW - 5, "n", "v"), NOW), { message: /expired/ });
  assert.deepEqual(groupDomains(parseNetscape(T(".a.com", "TRUE", "/", "FALSE", 0, "x", "1") + "\n" + T("a.com", "FALSE", "/", "FALSE", 0, "y", "1") + "\n" + T("b.com", "FALSE", "/", "FALSE", 0, "z", "1"), NOW).cookies), [{ domain: "a.com", count: 2 }, { domain: "b.com", count: 1 }]);
});

test("helper script compiles", () => { new Script(HELPER_SCRIPT); });

// ---- service, with a fake browser: per-user isolation, single use, selection, no secret leakage ----
function service() {
  const calls: Array<{ userId: string; input: any }> = [];
  let denied = false;
  const fake: any = {
    state: async () => "running",
    assertAllowed: async () => { if (denied) throw Object.assign(new Error("off"), { code: "disabled" }); },
    ensure: async (u: string) => ({ wsEndpoint: `ws://127.0.0.1:1/${u}`, token: "t".repeat(64) }),
    runHelper: async (userId: string, _s: string, input: string) => {
      const i = JSON.parse(input); calls.push({ userId, input: i });
      if (i.mode === "import") return { code: 0, out: { imported: i.cookies.length, failed: 0 } };
      if (i.mode === "bookmarks-write") return { code: 0, out: { bookmarks: i.bookmarks.length } };
      if (i.mode === "bookmarks-count") return { code: 0, out: { bookmarks: 0 } };
      if (i.mode === "list") return { code: 0, out: { domains: [{ domain: "a.com", count: 1 }] } };
      return { code: 0, out: { removed: 2 } };
    },
  };
  let now = Date.now();
  return { svc: new BrowserImportService(fake, () => now), calls, deny: () => { denied = true; }, tick: (ms: number) => { now += ms; } };
}
const FILE = [T(".a.com", "TRUE", "/", "TRUE", 0, "s1", "SECRETVALUE1"), T(".b.com", "TRUE", "/", "TRUE", 0, "s2", "v2")].join("\n");

test("preview returns domains and counts only; commit imports the selected domains and is single use", async () => {
  const { svc, calls } = service();
  const p = svc.preview("alice", FILE);
  assert.deepEqual(p.cookies.domains, [{ domain: "a.com", count: 1 }, { domain: "b.com", count: 1 }]);
  assert.ok(!JSON.stringify(p).includes("SECRETVALUE1"), "preview never echoes cookie values");
  const r = await svc.commit("alice", { importId: p.importId, domains: ["a.com"], bookmarks: false });
  assert.deepEqual(r, { imported: 1, failed: 0, bookmarks: 0 });
  assert.deepEqual(calls[0].input.cookies.map((c: any) => c.name), ["s1"]);
  await assert.rejects(svc.commit("alice", { importId: p.importId, domains: ["a.com"] }), { status: 404 });
});

test("per-user isolation: another user cannot commit or consume someone's pending import", async () => {
  const { svc, calls } = service();
  const p = svc.preview("alice", FILE);
  await assert.rejects(svc.commit("bob", { importId: p.importId, domains: ["a.com", "b.com"] }), { status: 404 });
  assert.equal(calls.length, 0);
  const r = await svc.commit("alice", { importId: p.importId, domains: ["a.com"] });
  assert.equal(r.imported, 1);
  // helper calls always carry the calling user, never another
  await svc.removeDomain("bob", "a.com");
  assert.equal(calls.at(-1)!.userId, "bob");
});

test("expiry, selection errors and bad input", async () => {
  const { svc, tick } = service();
  const p = svc.preview("alice", FILE);
  await assert.rejects(svc.commit("alice", { importId: p.importId, domains: [] }), { code: "nothing_selected" });
  const p2 = svc.preview("alice", FILE);
  tick(11 * 60 * 1000);
  await assert.rejects(svc.commit("alice", { importId: p2.importId, domains: ["a.com"] }), { status: 404 });
  assert.throws(() => svc.preview("alice", 5), { code: "invalid_import" });
  await assert.rejects(svc.removeDomain("alice", "a.com; rm -rf"), { code: "invalid_domain" });
  assert.deepEqual(await svc.list("alice"), { domains: [{ domain: "a.com", count: 1 }], bookmarks: 0 });
});

test("bookmarks: unclosed openers parse in linear time (ReDoS guard)", () => {
  for (const unit of ["<a x>", "<a <a ", "<h3>"]) {
    const t0 = Date.now();
    const html = "<DL>" + unit.repeat(Math.floor(1_000_000 / unit.length)) + '<A HREF="https://ok.example/">ok</A>';
    const r = parseBookmarksHtml(html);
    assert.ok(Date.now() - t0 < 3000, `slow for ${unit}: ${Date.now() - t0}ms`);
    assert.ok(r.bookmarks.length <= 1);
  }
  const big = "<a x>".repeat(200_000);
  const t1 = Date.now(); parseBookmarksHtml(big); assert.ok(Date.now() - t1 < 3000);
  assert.throws(() => parseBookmarksHtml("x".repeat(1024 * 1024 + 1)), /too large/);
});

test("import commit/list/remove honour the Browser toggle and never reach the helper when off", async () => {
  const { svc, calls, deny } = service();
  const p = svc.preview("alice", FILE);
  deny();
  await assert.rejects(svc.commit("alice", { importId: p.importId, domains: ["a.com"] }), { code: "disabled" });
  await assert.rejects(svc.list("alice"), { code: "disabled" });
  await assert.rejects(svc.removeDomain("alice", "a.com"), { code: "disabled" });
  assert.equal(calls.length, 0);
});
