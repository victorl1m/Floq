import test from "node:test";
import assert from "node:assert/strict";
import { CatalogClient, CatalogError, DEFAULT_CATALOG_URL, PACKAGE_PATH_PREFIX, packageUrlAllowed, parseCatalog } from "../dist/plugins/catalog.js";
import { PACKAGE_MAX_BYTES, PackageError } from "../dist/plugins/package.js";

const SHA = "a".repeat(64);
const PKG = `https://github.com${PACKAGE_PATH_PREFIX}movidesk-v1.1.0/movidesk-1.1.0.floqpkg.json`;
const entry = (over: Record<string, unknown> = {}) => ({ id: "movidesk", name: "Movidesk", version: "1.1.0", apiVersion: 1, description: "d", icon: "IconHeadset", scope: "user", secrets: ["MOVIDESK_TOKEN"], network: ["api.movidesk.com"], contributes: ["taskSources"], minFloq: "0.7.0", package: PKG, sha256: SHA, ...over });
const catalog = (plugins: unknown[]) => Buffer.from(JSON.stringify({ format: 1, plugins }));

test("package URLs: https, github.com, the floq-plugins release path, nothing else", () => {
  assert.ok(packageUrlAllowed(PKG));
  for (const bad of ["http://github.com" + PACKAGE_PATH_PREFIX + "x", "https://evil.test" + PACKAGE_PATH_PREFIX + "x", "https://github.com/other/repo/releases/download/x", "https://github.com.evil.test" + PACKAGE_PATH_PREFIX + "x",
    "https://u:p@github.com" + PACKAGE_PATH_PREFIX + "x", "https://github.com:8443" + PACKAGE_PATH_PREFIX + "x", "https://github.com" + PACKAGE_PATH_PREFIX + "../../x", "javascript:alert(1)", "not a url", "https://raw.githubusercontent.com/victorl1m/floq-plugins/main/x"]) assert.ok(!packageUrlAllowed(bad), bad);
});

test("package URLs may also live in a floq-plugin-<id> repo of the same owner, and only there", () => {
  const ok = (repo: string) => `https://github.com/victorl1m/${repo}/releases/download/v1.0.0/x.floqpkg.json`;
  for (const repo of ["floq-plugin-movidesk", "floq-plugin-azure-devops", "floq-plugin-waha", "floq-plugin-a1"]) assert.ok(packageUrlAllowed(ok(repo)), repo);
  for (const bad of [ok("floq-plugin-"), ok("floq-plugin"), ok("floq-plugins2"), ok("floq-plugin-Movidesk"), ok("floq-plugin--x"), ok("floq-plugin-x-"), ok("floq-plugin-a/b"), ok("floq-pluginx"), ok("xfloq-plugin-a"),
    "https://github.com/evil/floq-plugin-movidesk/releases/download/v1/x", "https://github.com/victorl1m2/floq-plugin-movidesk/releases/download/v1/x", "https://github.com/victorl1m/floq-plugin-movidesk/archive/main.zip",
    "https://github.com/victorl1m/floq-plugin-movidesk/releases/latest/download/x", "https://github.com/victorl1m/floq-plugin-movidesk/releases/download/../../x",
    "http://github.com/victorl1m/floq-plugin-movidesk/releases/download/v1/x", "https://evil.test/victorl1m/floq-plugin-movidesk/releases/download/v1/x", "https://u:p@github.com/victorl1m/floq-plugin-movidesk/releases/download/v1/x"]) assert.ok(!packageUrlAllowed(bad), bad);
});

test("the catalog keeps valid entries and drops malformed, duplicate or off-location ones", () => {
  const list = parseCatalog(catalog([entry(), entry({ id: "azure-devops", name: "Azure DevOps" }), entry({ id: "azure-devops" }), entry({ id: "Bad_Id" }), entry({ id: "x2", package: "https://evil.test/p.json" }),
    entry({ id: "x3", sha256: "short" }), entry({ id: "x4", version: "latest" }), entry({ id: "x5", apiVersion: 2 }), null, "x"]));
  assert.deepEqual(list.map((e) => e.id), ["movidesk", "azure-devops"]);
  assert.deepEqual([list[0].secrets, list[0].network, list[0].contributes, list[0].sha256], [["MOVIDESK_TOKEN"], ["api.movidesk.com"], ["taskSources"], SHA]);
  assert.throws(() => parseCatalog(Buffer.from("nope")), CatalogError);
  assert.throws(() => parseCatalog(Buffer.from(JSON.stringify({ format: 2, plugins: [] }))), /unsupported/);
});

test("a deprecated entry keeps its notice: text as given (capped), true becomes a generic sentence, anything else is not deprecated", () => {
  const list = parseCatalog(catalog([entry({ deprecated: "  WhatsApp is now built into Floq: Settings > Integrations.  " }), entry({ id: "b2", deprecated: true }), entry({ id: "c3", deprecated: "x".repeat(900) }), entry({ id: "d4", deprecated: 5 }), entry({ id: "e5", deprecated: "   " }), entry({ id: "f6" })]));
  assert.deepEqual(list.map((e) => e.deprecated?.length), [57, 26, 300, undefined, undefined, undefined]);
  assert.equal(list[0].deprecated, "WhatsApp is now built into Floq: Settings > Integrations.");
  assert.equal(list[1].deprecated, "This plugin is deprecated.");
});

const res = (body: string | Buffer, init: ResponseInit = {}) => new Response(body, init);

test("the catalog is fetched from the fixed URL (or FLOQ_PLUGIN_CATALOG) with a timeout and no auto-redirects", async () => {
  const seen: { url: string; init: any }[] = [];
  const c = new CatalogClient({ fetchImpl: async (url, init) => { seen.push({ url, init }); return res(catalog([entry()])); } });
  assert.equal(c.catalogUrl, DEFAULT_CATALOG_URL);
  assert.equal((await c.list()).length, 1);
  assert.equal(seen[0].url, DEFAULT_CATALOG_URL);
  assert.equal(seen[0].init.redirect, "manual");
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  const custom = new CatalogClient({ catalogUrl: "https://catalog.test/index.json", fetchImpl: async () => res(catalog([])) });
  assert.deepEqual(await custom.list(), []);
});

test("a package from the wrong host or path is refused without a request", async () => {
  let calls = 0;
  const c = new CatalogClient({ fetchImpl: async () => { calls++; return res("{}"); } });
  for (const pkg of ["https://evil.test/x.json", "http://github.com" + PACKAGE_PATH_PREFIX + "x", "https://github.com/other/repo/releases/download/x"]) await assert.rejects(c.download({ package: pkg }), PackageError);
  assert.equal(calls, 0);
});

test("redirects are followed only to the pinned CDN hosts over https", async () => {
  const hops: string[] = [];
  const cdn = "https://objects.githubusercontent.com/blob/1";
  const ok = new CatalogClient({ fetchImpl: async (url) => { hops.push(url); return url === PKG ? res("", { status: 302, headers: { location: cdn } }) : res("PACKAGE-BYTES"); } });
  assert.equal((await ok.download({ package: PKG })).toString(), "PACKAGE-BYTES");
  assert.deepEqual(hops, [PKG, cdn]);
  const ok2 = new CatalogClient({ fetchImpl: async (url) => (url === PKG ? res("", { status: 302, headers: { location: "https://release-assets.githubusercontent.com/x" } }) : res("OK")) });
  assert.equal((await ok2.download({ package: PKG })).toString(), "OK");
  for (const location of ["https://evil.test/p.json", "http://objects.githubusercontent.com/x", "https://github.com/other/x", "https://objects.githubusercontent.com.evil.test/x", "file:///etc/passwd", "https://127.0.0.1/x"]) {
    const seen: string[] = [];
    const bad = new CatalogClient({ fetchImpl: async (url) => { seen.push(url); return url === PKG ? res("", { status: 302, headers: { location } }) : res("SHOULD-NOT-BE-READ"); } });
    await assert.rejects(bad.download({ package: PKG }), (e: unknown) => e instanceof CatalogError, location);
    assert.deepEqual(seen, [PKG], "the off-list location was never requested: " + location);
  }
  const loop = new CatalogClient({ fetchImpl: async () => res("", { status: 302, headers: { location: cdn } }) });
  await assert.rejects(loop.download({ package: PKG }), /redirects/);
});

test("the 5 MiB cap holds for a declared length and for a stream that lies about it", async () => {
  const big = Buffer.alloc(PACKAGE_MAX_BYTES + 1, 97);
  const streamed = new CatalogClient({ fetchImpl: async () => res(big) });
  await assert.rejects(streamed.download({ package: PKG }), /too large/);
  const declared = new CatalogClient({ fetchImpl: async () => res("x", { headers: { "content-length": String(PACKAGE_MAX_BYTES + 5) } }) });
  await assert.rejects(declared.download({ package: PKG }), /too large/);
  const exact = new CatalogClient({ fetchImpl: async () => res(Buffer.alloc(PACKAGE_MAX_BYTES, 97)) });
  assert.equal((await exact.download({ package: PKG })).length, PACKAGE_MAX_BYTES);
});

test("server errors and network failures become generic catalog errors without upstream text", async () => {
  const c500 = new CatalogClient({ fetchImpl: async () => res("secret upstream body", { status: 500 }) });
  await assert.rejects(c500.download({ package: PKG }), (e: any) => e instanceof CatalogError && /HTTP 500/.test(e.message) && !/secret/.test(e.message));
  const boom = new CatalogClient({ fetchImpl: async () => { throw new Error("ECONNREFUSED 10.0.0.1:443 token=abc"); } });
  await assert.rejects(boom.list(), (e: any) => e instanceof CatalogError && !/10\.0\.0\.1|token/.test(e.message));
});
