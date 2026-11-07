import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";
import { PluginHost } from "../dist/plugins/host.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { echoManifest } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const SECRET = "tok/Isolation+value \"q\" 31337";
const forms = [SECRET, encodeURIComponent(SECRET), JSON.stringify(SECRET).slice(1, -1), Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("base64url")];
const clean = (text: string, where: string) => { for (const f of forms) assert.ok(!text.includes(f), "a secret form appeared in " + where); };

test("a seeded plugin secret is invisible to the vault and to every agent-reachable route", async (t) => {
  const f = await fakePool(); await f.addUser("u1");
  const key = Buffer.alloc(32, 5);
  const vault = new Vault(f.pool as never, { encryptionKey: key } as never);
  const plugin = definePlugin({
    manifest: echoManifest({ id: "iso", name: "Iso", scope: "user", contributes: { internalRoutes: true, routes: false, migrations: false } }),
    start(ctx) { ctx.internalRoutes.call("/ping", () => ({ pong: true })); },
  });
  const host = new PluginHost(f.pool as never, { plugins: [plugin], encryptionKey: key, sink: () => undefined });
  await host.load(); await host.enable("iso", "u1");
  await host.secrets.set("iso", "u1", "ECHO_TOKEN", SECRET, "u1");
  await vault.create("u1", null, { name: "MY_OWN", value: "unrelated" });

  // Vault service surface
  const listed = await vault.list("u1");
  assert.deepEqual(listed.map((s) => s.name), ["MY_OWN"]);
  clean(JSON.stringify(listed), "vault.list");
  const all = await vault.reveal("u1", null, null, "s1");
  assert.deepEqual(Object.keys(all), ["MY_OWN"]);
  clean(JSON.stringify(all), "vault.reveal");
  assert.deepEqual(await vault.reveal("u1", ["ECHO_TOKEN"], null, "s1"), {});
  // The session env builder injects vault.reveal(user, null, "env", session)
  clean(JSON.stringify(await vault.reveal("u1", null, "env", "s1")), "env injection");
  clean(JSON.stringify((await f.db.query("SELECT * FROM vault_secrets")).rows), "vault_secrets");
  clean(JSON.stringify((await f.db.query("SELECT * FROM vault_audit")).rows), "vault_audit");

  // HTTP surface with the agent's own session token
  const port: number = await new Promise((r) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", bootstrapAdminEmail: null };
  const server = createRuntimeServer({ config, manager: { activeCount: 0 }, auth: { handler() {}, api: { getSession: async () => null } }, settings: {}, github: {}, vault, orchestrator: {}, pool: f.pool, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {}, plugins: host } as never);
  await server.listen();
  t.after(async () => { await server.close(); });
  const token = vault.issueToken("u1", "sess-1");
  const hit = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const text = await r.text(); clean(text, method + " " + path + " (" + r.status + ")");
    return { status: r.status, text };
  };
  const secretsList = await hit("GET", "/internal/vault/secrets");
  assert.equal(secretsList.status, 200); assert.ok(!secretsList.text.includes("ECHO_TOKEN"), "name leaked into the vault list");
  await hit("POST", "/internal/vault/reveal", { names: ["ECHO_TOKEN"] });
  await hit("POST", "/internal/vault/reveal", { names: ["MY_OWN"] });
  await hit("POST", "/internal/vault/reveal", {});
  await hit("POST", "/internal/vault/run", { names: ["ECHO_TOKEN"], argv: ["true"] });
  for (const p of ["secrets/global", "secrets/names", "secrets/pull", "secrets/add", "plugins/list", "plugins/iso/ping", "plugins/iso/missing"]) await hit(p.startsWith("plugins/list") || p === "secrets/global" ? "GET" : "POST", "/internal/" + p, { name: "ECHO_TOKEN" });
  // the plugin's own status route is user-bearer only and also value-free
  assert.equal((await hit("GET", "/v1/plugins/iso/secrets")).status, 401);
});
