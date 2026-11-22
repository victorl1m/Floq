import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../dist/plugins/host.js";
import { PluginInstaller } from "../dist/plugins/installer.js";
import { CatalogClient, parseRepoUrl, repoDownloadAllowed } from "../dist/plugins/catalog.js";
import { sha256Hex } from "../dist/plugins/package.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { forbidden } from "../dist/errors.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { echoManifest } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const RT = (v: string) => `export default { start(ctx) { ctx.routes.get("/ping", () => ({ v: "${v}" })); } };`;
const pkg = (version: string, id = "mine", over: Record<string, unknown> = {}) => {
  const manifest = echoManifest({ id, name: "Mine", version, scope: "user", secrets: [{ name: "MINE_TOKEN", description: "t", required: true }], settings: [], contributes: { routes: true }, ...over });
  const bytes = Buffer.from(JSON.stringify({ format: 1, manifest, runtime: RT(version), ui: null, skills: {} }));
  return { bytes, sha256: sha256Hex(bytes), version, id };
};
const asset = (o: string, r: string, v: string, id = "mine") => `https://github.com/${o}/${r}/releases/download/v${v}/${id}-${v}.floqpkg.json`;

async function setup() {
  const f = await fakePool(); await f.addUser("admin"); await f.addUser("member");
  const releases = new Map<string, { tag: string; assets: { name: string; browser_download_url: string }[] }>();
  const files = new Map<string, Buffer>();
  const requests: string[] = [];
  const publish = (o: string, r: string, p: ReturnType<typeof pkg>, over: { url?: string; extra?: boolean; none?: boolean } = {}) => {
    const url = over.url ?? asset(o, r, p.version, p.id);
    files.set(url, p.bytes);
    const assets = over.none ? [] : [{ name: `${p.id}-${p.version}.floqpkg.json`, browser_download_url: url }, ...(over.extra ? [{ name: "other.floqpkg.json", browser_download_url: url }] : [])];
    releases.set(`${o}/${r}`.toLowerCase(), { tag: `v${p.version}`, assets });
  };
  const fetchImpl = async (url: string) => {
    requests.push(url);
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/.exec(url);
    if (m) { const rel = releases.get(`${m[1]}/${m[2]}`.toLowerCase()); return rel ? new Response(JSON.stringify({ tag_name: rel.tag, assets: rel.assets })) : new Response("nf", { status: 404 }); }
    if (url === "https://catalog.test/index.json") return new Response(JSON.stringify({ format: 1, plugins: [] }));
    const b = files.get(url); return b ? new Response(b) : new Response("nope", { status: 404 });
  };
  const builtin = definePlugin({ manifest: echoManifest({ id: "builtin-one", name: "Built-in" }) });
  const host = new PluginHost(f.pool as never, { plugins: [builtin], encryptionKey: Buffer.alloc(32, 9), sink: () => undefined, retryDelaysMs: [0, 0] });
  await host.load();
  const pluginDir = mkdtempSync(join(tmpdir(), "floq-plugins-"));
  const installer = new PluginInstaller({ pool: f.pool as never, host, catalog: new CatalogClient({ catalogUrl: "https://catalog.test/index.json", fetchImpl: fetchImpl as never }), pluginDir });
  host.setInstaller(installer);
  const call = (userId: string, method: string, path: string, body?: unknown) => host.handle({ userId, method, pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => body, requireAdmin: async () => { if (userId !== "admin") throw forbidden("Administrator access required"); } }) as Promise<any>;
  return { ...f, host, call, publish, requests, files };
}
const URL1 = "https://github.com/someone/my-plugin";

test("repository addresses: https github.com owner/repo only", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/someone/my-plugin"), { owner: "someone", repo: "my-plugin" });
  assert.deepEqual(parseRepoUrl(" https://github.com/Some-One/my.plugin.git/ "), { owner: "Some-One", repo: "my.plugin" });
  for (const bad of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/c", "https://github.com/a/b/tree/main", "https://github.com/a/b?x=1", "https://github.com/a/b#h",
    "https://u:p@github.com/a/b", "https://github.com:8443/a/b", "https://github.com/-a/b", "https://github.com/a/..", "https://github.com/a/.hidden", "https://github.com.evil.test/a/b", "not a url", "", 5, null])
    assert.equal(parseRepoUrl(bad), null, String(bad));
  assert.ok(repoDownloadAllowed(asset("someone", "my-plugin", "1.0.0"), { owner: "someone", repo: "my-plugin" }));
  assert.ok(!repoDownloadAllowed(asset("other", "my-plugin", "1.0.0"), { owner: "someone", repo: "my-plugin" }));
  assert.ok(!repoDownloadAllowed("https://github.com/someone/my-plugin/archive/main.zip", { owner: "someone", repo: "my-plugin" }));
});

test("inspect: admin only, shows what the package declares and its sha256, stores and runs nothing", async () => {
  const t = await setup(); const p = pkg("1.0.0"); t.publish("someone", "my-plugin", p);
  await assert.rejects(t.call("member", "POST", "/v1/plugins/inspect-url", { url: URL1 }), (e: any) => e.status === 403);
  const { body } = await t.call("admin", "POST", "/v1/plugins/inspect-url", { url: URL1 });
  assert.deepEqual([body.preview.id, body.preview.version, body.preview.sha256, body.preview.repo, body.preview.secrets, body.preview.installedVersion], ["mine", "1.0.0", p.sha256, "someone/my-plugin", ["MINE_TOKEN"], null]);
  assert.equal((await t.db.query("SELECT * FROM floq_plugin_packages")).rows.length, 0);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/inspect-url", { url: "https://evil.test/a/b" }), (e: any) => e.code === "invalid_repo_url");
});

test("install from any owner: needs the reviewed sha256 and the typed id; the plugin stays off and remembers its repository", async () => {
  const t = await setup(); const p = pkg("1.0.0"); t.publish("someone", "my-plugin", p);
  const go = (b: Record<string, unknown>) => t.call("admin", "POST", "/v1/plugins/install-url", { url: URL1, sha256: p.sha256, confirm: "mine", ...b });
  await assert.rejects(t.call("member", "POST", "/v1/plugins/install-url", { url: URL1, sha256: p.sha256, confirm: "mine" }), (e: any) => e.status === 403);
  await assert.rejects(go({ confirm: "" }), (e: any) => e.code === "confirmation_required");
  await assert.rejects(go({ sha256: "0".repeat(64) }), (e: any) => e.code === "release_changed");
  await assert.rejects(go({ sha256: undefined }), (e: any) => e.code === "release_changed");
  assert.equal((await t.db.query("SELECT * FROM floq_plugin_packages")).rows.length, 0);
  const r = await go({});
  assert.deepEqual([r.body.plugin.id, r.body.plugin.status, r.body.plugin.enabled], ["mine", "disabled", false]);
  assert.equal((await t.db.query("SELECT source_repo FROM floq_plugin_packages")).rows[0].source_repo, "someone/my-plugin");
  assert.deepEqual((await t.call("admin", "GET", "/v1/plugins/sources")).body, { sources: { mine: "someone/my-plugin" } });
  await assert.rejects(go({}), (e: any) => e.code === "already_installed");
});

test("a repository that does not publish a clean release is refused", async () => {
  const t = await setup(); const p = pkg("1.0.0");
  const go = () => t.call("admin", "POST", "/v1/plugins/inspect-url", { url: URL1 });
  await assert.rejects(go(), (e: any) => /no published release/.test(e.message));
  t.publish("someone", "my-plugin", p, { none: true }); await assert.rejects(go(), (e: any) => /no \.floqpkg\.json/.test(e.message));
  t.publish("someone", "my-plugin", p, { extra: true }); await assert.rejects(go(), (e: any) => /more than one/.test(e.message));
  t.publish("someone", "my-plugin", p, { url: asset("attacker", "elsewhere", "1.0.0") }); await assert.rejects(go(), (e: any) => /not hosted in that repository/.test(e.message));
  assert.ok(!t.requests.some((u) => u.includes("attacker")));
});

test("built-in ids, bad packages and wrong catalog-style clashes are refused", async () => {
  const t = await setup();
  t.publish("someone", "my-plugin", pkg("1.0.0", "builtin-one"));
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/inspect-url", { url: URL1 }), (e: any) => /built-in/.test(e.message));
  const bad = { bytes: Buffer.from("{ nope"), sha256: "", version: "1.0.0", id: "mine" };
  t.publish("someone", "my-plugin", bad as never);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/inspect-url", { url: URL1 }), (e: any) => e.status === 422);
});

test("update is manual and only from the same repository: newer only, reviewed sha256, catalog update refused", async () => {
  const t = await setup(); const p1 = pkg("1.0.0"); t.publish("someone", "my-plugin", p1);
  await t.call("admin", "POST", "/v1/plugins/install-url", { url: URL1, sha256: p1.sha256, confirm: "mine" });
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/mine/update", { sha256: p1.sha256 }), (e: any) => e.code === "up_to_date");
  const p2 = pkg("1.1.0"); t.publish("someone", "my-plugin", p2);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/mine/update", {}), (e: any) => e.code === "release_changed");
  await assert.rejects(t.call("member", "POST", "/v1/plugins/mine/update", { sha256: p2.sha256 }), (e: any) => e.status === 403);
  await t.call("admin", "POST", "/v1/plugins/mine/update", { sha256: p2.sha256 });
  assert.equal((await t.db.query("SELECT version FROM floq_plugin_packages")).rows[0].version, "1.1.0");
  t.publish("someone", "my-plugin", pkg("1.0.5"));
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/mine/update", { sha256: pkg("1.0.5").sha256 }), (e: any) => e.code === "downgrade_refused");
  t.publish("someone", "my-plugin", pkg("2.0.0", "another"));
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/mine/update", { sha256: pkg("2.0.0", "another").sha256 }), (e: any) => e.code === "id_changed");
});

test("updates check (for the toast on app open): admin only, read-only, lists repository plugins with a newer release and skips unreachable ones", async () => {
  const t = await setup(); const p1 = pkg("1.0.0"); t.publish("someone", "my-plugin", p1);
  await t.call("admin", "POST", "/v1/plugins/install-url", { url: URL1, sha256: p1.sha256, confirm: "mine" });
  assert.deepEqual((await t.call("admin", "GET", "/v1/plugins/updates")).body, { updates: [], deprecated: [] });
  await assert.rejects(t.call("member", "GET", "/v1/plugins/updates"), (e: any) => e.status === 403);
  t.publish("someone", "my-plugin", pkg("1.2.0"));
  assert.deepEqual((await t.call("admin", "GET", "/v1/plugins/updates")).body, { updates: [{ id: "mine", name: "Mine", installedVersion: "1.0.0", availableVersion: "1.2.0", repo: "someone/my-plugin" }], deprecated: [] });
  assert.equal((await t.db.query("SELECT version FROM floq_plugin_packages")).rows[0].version, "1.0.0"); // nothing was installed
  t.files.clear();
  assert.deepEqual((await t.call("admin", "GET", "/v1/plugins/updates")).body, { updates: [], deprecated: [] });
});
