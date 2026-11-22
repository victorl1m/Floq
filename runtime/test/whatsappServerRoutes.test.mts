import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createNetServer } from "./fixtures/plugins/freePort.mts";
import { Vault } from "../dist/vault.js";
import { PluginHost } from "../dist/plugins/host.js";
import { Notifications } from "../dist/notifications.js";
import { BuiltinWhatsapp, builtinWhatsappFromEnv, whatsappIntegration, type ContainerInfo, type WahaDocker } from "../dist/whatsappServer.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

// The server module loads node-pty; hosts without its native binding (CI sandboxes) get a stub, since no terminal is opened here.
const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request !== "node-pty") return load.call(this, request, ...rest);
  try { return load.call(this, request, ...rest); } catch { return { spawn() { throw new Error("no pty in this test"); } }; }
};
const { createRuntimeServer } = await import("../dist/server.js");

test.after(closeAll);
const KEY = "k".repeat(40);

async function harness(t: any, env: Record<string, string> = { FLOQ_WHATSAPP_API_KEY: KEY }) {
  const f = await fakePool(); await f.addUser("admin"); await f.addUser("member");
  await f.db.exec("INSERT INTO collaboration.user_roles (user_id, role) VALUES ('admin', 'admin')");
  const cfg = builtinWhatsappFromEnv(env);
  const calls: string[] = [];
  const containers = new Map<string, ContainerInfo>([["old1", { id: "old1", name: "floq-waha-1", image: "devlikeapro/waha:noweb-2026.9.2", running: true, health: "healthy" }]]);
  let seq = 0;
  const docker: WahaDocker = {
    available: () => true,
    find: async () => [...containers.values()].find((c) => !c.name.includes("-floq-old-")) ?? null,
    inspect: async (id) => ({ ...containers.get(id)!, running: true, health: "healthy" }),
    pull: async (repo, tag) => { calls.push(`pull ${repo}:${tag}`); },
    stop: async () => undefined, rename: async (id, name) => { containers.get(id)!.name = name; },
    createLike: async (_o, image, name) => { const id = "new" + ++seq; containers.set(id, { id, name, image, running: false, health: "starting" }); return id; },
    start: async () => undefined, remove: async (id) => { containers.delete(id); },
  };
  const sessions = { list: [{ status: "WORKING" }] };
  const seen: { url: string; key: string | null }[] = [];
  const wahaFetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input), key = init?.headers?.["X-Api-Key"] ?? null;
    seen.push({ url, key });
    if (url.startsWith("https://api.github.com/")) return Response.json([{ tag_name: "2026.10.1" }, { tag_name: "2026.11.1", prerelease: true }]);
    if (!url.startsWith("http://waha:3000")) throw new Error("ECONNREFUSED");
    if (key !== KEY) return new Response("{}", { status: 401 });
    if (url.endsWith("/api/server/version")) return Response.json({ version: "2026.9.2", engine: "NOWEB", tier: "CORE" });
    return Response.json(sessions.list);
  }) as unknown as typeof fetch;
  const host: PluginHost = new PluginHost(f.pool as never, { plugins: [], encryptionKey: Buffer.alloc(32, 9), sink: () => undefined, integrations: { waha: whatsappIntegration(cfg) } });
  await host.load();
  const notes: { userId: string; title: string }[] = [];
  const whatsapp = new BuiltinWhatsapp({ cfg, pool: f.pool as never, docker, fetchImpl: wahaFetch, plugin: () => host.serviceOf("waha"), notify: async (n) => { notes.push({ userId: "admin", title: n.title }); }, swap: { pollMs: 0, sleep: async () => undefined } });
  const tokens: Record<string, string> = { "admin-token": "admin", "member-token": "member" };
  const auth = { handler() {}, api: { getSession: async ({ headers }: any) => { const u = tokens[(headers.get("authorization") ?? "").replace("Bearer ", "")]; return u ? { user: { id: u } } : null; } } };
  const port = await createNetServer();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "1.0.0", logLevel: "error", databaseUrl: "postgres://x/y", bootstrapAdminEmail: null, providers: { claude: "true", codex: "true" } };
  const vault = new Vault(f.pool as never, { encryptionKey: Buffer.alloc(32, 5) } as never);
  const server = createRuntimeServer({ config, manager: { activeCount: 2 }, auth, settings: {}, github: {}, vault, orchestrator: {}, pool: f.pool, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {}, plugins: host, whatsapp, notifications: new Notifications({ pool: f.pool as never }) } as never);
  await server.listen();
  t.after(async () => { await server.close(); });
  const v1 = async (token: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
  };
  return { v1, calls, seen, notes, sessions, whatsapp };
}

test("whatsapp-server routes: administrators only, status and health carry no key", async (t) => {
  const h = await harness(t);
  for (const [method, path] of [["GET", "/v1/admin/whatsapp-server"], ["GET", "/v1/admin/whatsapp-server/health"], ["POST", "/v1/admin/whatsapp-server/test"], ["PUT", "/v1/admin/whatsapp-server/auto-update"]] as const) {
    assert.equal((await h.v1(null, method, path, method === "GET" ? undefined : {})).status, 401, path);
    assert.equal((await h.v1("member-token", method, path, method === "GET" ? undefined : {})).status, 403, path);
  }
  const st = await h.v1("admin-token", "GET", "/v1/admin/whatsapp-server");
  assert.equal(st.status, 200);
  assert.deepEqual(st.json.builtin, { enabled: true, state: "running", version: "2026.9.2", engine: "NOWEB", tier: "CORE", image: "devlikeapro/waha:noweb-2026.9.2", managed: true });
  assert.deepEqual(st.json.plugin, { installed: false, enabled: false, mode: "none" });
  assert.deepEqual(st.json.autoUpdate, { enabled: true, quietMinutes: 30, lastCheckAt: null, last: null });
  const health = await h.v1("admin-token", "GET", "/v1/admin/whatsapp-server/health");
  assert.equal(health.json.ok, true); assert.equal(health.json.version, "2026.9.2"); assert.equal(typeof health.json.latencyMs, "number");
  assert.ok(!st.text.includes(KEY) && !health.text.includes(KEY));
  assert.equal((await h.v1("admin-token", "GET", "/v1/admin/whatsapp-server/nothing")).status, 404);
});

test("whatsapp-server routes: test connection and the auto-update setting", async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.v1("admin-token", "POST", "/v1/admin/whatsapp-server/test", { baseUrl: "", apiKey: "" })).json, { ok: true, state: "running", version: "2026.9.2", engine: "NOWEB" });
  const ext = await h.v1("admin-token", "POST", "/v1/admin/whatsapp-server/test", { baseUrl: "https://waha.example.com", apiKey: "theirs" });
  assert.deepEqual(ext.json, { ok: false, state: "unreachable", version: null, engine: null, error: "The server did not answer." });
  assert.deepEqual(h.seen.at(-1), { url: "https://waha.example.com/api/server/version", key: "theirs" });
  assert.equal((await h.v1("admin-token", "POST", "/v1/admin/whatsapp-server/test", { baseUrl: "ftp://x" })).status, 400);
  const put = await h.v1("admin-token", "PUT", "/v1/admin/whatsapp-server/auto-update", { enabled: false, quietMinutes: 90 });
  assert.deepEqual({ enabled: put.json.autoUpdate.enabled, quietMinutes: put.json.autoUpdate.quietMinutes }, { enabled: false, quietMinutes: 90 });
  assert.equal((await h.v1("admin-token", "GET", "/v1/admin/whatsapp-server")).json.autoUpdate.quietMinutes, 90);
  assert.equal((await h.v1("admin-token", "PUT", "/v1/admin/whatsapp-server/auto-update", { quietMinutes: 1 })).status, 400);
});

test("updates routes: the WhatsApp server is listed and updated without stopping agents; busy and QR login answer 409", async (t) => {
  const h = await harness(t);
  const list = await h.v1("admin-token", "GET", "/v1/admin/updates?refresh=1");
  assert.deepEqual(list.json.items.find((i: any) => i.target === "whatsapp"), { target: "whatsapp", current: "2026.9.2", latest: "2026.10.1", updateAvailable: true, source: "github:devlikeapro/waha", managed: true });
  const busy = await h.v1("admin-token", "POST", "/v1/admin/updates/apply", { target: "whatsapp" });
  assert.equal(busy.status, 409); assert.equal(busy.json.error?.code ?? busy.json.code, "whatsapp_busy");
  h.sessions.list = [{ status: "SCAN_QR_CODE" }];
  const login = await h.v1("admin-token", "POST", "/v1/admin/updates/apply", { target: "whatsapp", force: true });
  assert.equal(login.status, 409); assert.equal(login.json.error?.code ?? login.json.code, "whatsapp_login_active");
  assert.deepEqual(h.calls, []);
  h.sessions.list = [{ status: "WORKING" }];
  const ok = await h.v1("admin-token", "POST", "/v1/admin/updates/apply", { target: "whatsapp", force: true });
  assert.equal(ok.status, 200);
  assert.deepEqual({ target: ok.json.target, ok: ok.json.ok, restarting: ok.json.restarting, activeSessions: ok.json.activeSessions }, { target: "whatsapp", ok: true, restarting: false, activeSessions: 2 });
  assert.deepEqual(h.calls, ["pull devlikeapro/waha:noweb-2026.10.1"]);
  assert.deepEqual(h.notes.map((n) => n.title), ["WhatsApp server updated"]);
  assert.equal((await h.v1("admin-token", "GET", "/v1/admin/whatsapp-server")).json.builtin.image, "devlikeapro/waha:noweb-2026.10.1");
  assert.equal((await h.v1("member-token", "POST", "/v1/admin/updates/apply", { target: "whatsapp", force: true })).status, 403);
});

test("without the built-in server: status says off, no whatsapp update row", async (t) => {
  const h = await harness(t, {});
  const st = await h.v1("admin-token", "GET", "/v1/admin/whatsapp-server");
  assert.equal(st.json.builtin.enabled, false); assert.equal(st.json.builtin.state, "off");
  const list = await h.v1("admin-token", "GET", "/v1/admin/updates?refresh=1");
  assert.equal(list.json.items.some((i: any) => i.target === "whatsapp"), false);
});
