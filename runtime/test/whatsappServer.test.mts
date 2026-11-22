import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BuiltinWhatsapp, WAHA_PINNED_TAG, autoUpdateDecision, builtinWhatsappFromEnv, healthVerdict, isQuiet, latestStable, parseWahaImage, parseWahaTag,
  swapContainer, wahaMessageEvent, wahaSendCall, wahaTag, whatsappIntegration, type ContainerInfo, type WahaDocker,
} from "../dist/whatsappServer.js";
import { UpdateService, isNewer, isUpdateTarget } from "../dist/updates.js";

const KEY = "k".repeat(40);
const cfg = (over: Record<string, string> = {}) => builtinWhatsappFromEnv({ FLOQ_WHATSAPP_API_KEY: KEY, ...over });

test("config: the key switches the built-in server on; a short or hashed key and FLOQ_WHATSAPP_BUILTIN=0 keep it off", () => {
  assert.deepEqual(builtinWhatsappFromEnv({}), { enabled: false, url: "http://waha:3000", apiKey: "", internalUrl: "http://runtime:8787", problem: null });
  const on = cfg({ FLOQ_PORT: "9000" });
  assert.equal(on.enabled, true);
  assert.equal(on.internalUrl, "http://runtime:9000");
  assert.equal(cfg({ FLOQ_WHATSAPP_URL: "http://wa.internal:3001/", FLOQ_INTERNAL_URL: "http://floq:8787/" }).url, "http://wa.internal:3001");
  const short = builtinWhatsappFromEnv({ FLOQ_WHATSAPP_API_KEY: "short" });
  assert.equal(short.enabled, false); assert.equal(short.apiKey, ""); assert.match(short.problem!, /too short/); assert.ok(!short.problem!.includes("short\""));
  assert.match(builtinWhatsappFromEnv({ FLOQ_WHATSAPP_API_KEY: "sha512:" + "a".repeat(128) }).problem!, /plain key/);
  const off = cfg({ FLOQ_WHATSAPP_BUILTIN: "0" });
  assert.equal(off.enabled, false); assert.equal(off.apiKey, "");
});

test("integration descriptor: defaults only when on; message webhooks and sends count as activity, receipts and reads do not", () => {
  assert.equal(whatsappIntegration(builtinWhatsappFromEnv({})).builtin, null);
  let n = 0;
  const i = whatsappIntegration(cfg(), () => n++);
  assert.deepEqual(i.builtin, { url: "http://waha:3000", secret: KEY, webhookBase: "http://runtime:8787" });
  assert.equal(i.urlSetting, "baseUrl"); assert.equal(i.secretName, "WAHA_API_KEY");
  i.onWebhook({ event: "message" }); i.onWebhook({ event: "message.ack" }); i.onWebhook({ event: "session.status" }); i.onWebhook(null);
  i.onFetch("POST", "http://waha:3000/api/sendText"); i.onFetch("GET", "http://waha:3000/api/sendText"); i.onFetch("POST", "http://waha:3000/api/default/chats/x/messages/read");
  assert.equal(n, 2);
  assert.equal(wahaMessageEvent({ event: "message.any" }), true);
  assert.equal(wahaSendCall("PUT", "http://waha:3000/api/reaction"), true);
  assert.equal(wahaSendCall("POST", "not a url"), false);
});

test("versions: tags keep their flavor, only the official versioned image is managed, pre-releases are ignored", () => {
  assert.deepEqual(parseWahaTag("noweb-2026.10.1"), { flavor: "noweb", version: "2026.10.1" });
  assert.deepEqual(parseWahaTag("noweb-arm-2026.9.2"), { flavor: "noweb-arm", version: "2026.9.2" });
  assert.deepEqual(parseWahaTag("2026.10.1"), { flavor: "", version: "2026.10.1" });
  for (const bad of ["latest", "noweb", "dev", "noweb-2026.10", "noweb-2026.10.1; rm -rf", ""]) assert.equal(parseWahaTag(bad), null);
  assert.equal(wahaTag("noweb-arm", "2026.11.1"), "noweb-arm-2026.11.1");
  assert.equal(wahaTag("", "2026.11.1"), "2026.11.1");
  assert.equal(parseWahaImage("devlikeapro/waha:noweb-2026.10.1")!.tag, "noweb-2026.10.1");
  assert.equal(parseWahaImage("devlikeapro/waha-plus:noweb-2026.10.1"), null);
  assert.equal(parseWahaImage("evil.example/devlikeapro/waha:noweb-2026.10.1"), null);
  assert.equal(parseWahaImage("devlikeapro/waha:latest"), null);
  assert.equal(latestStable([
    { tag_name: "2026.12.1", prerelease: true }, { tag_name: "2026.11.3", draft: true }, { tag_name: "2026.9.2" }, { tag_name: "2026.10.1" }, { tag_name: "v2026.2.9" }, { tag_name: "nightly" }, {},
  ]), "2026.10.1");
  assert.equal(latestStable([]), null);
  assert.equal(isNewer("2026.9.2", "2026.10.1"), true); // numeric, not text: 10 > 9
  assert.equal(isNewer("2026.10.1", "2026.10.1"), false);
  assert.equal(isNewer("2026.10.1", "2026.9.2"), false);
  assert.equal(isNewer("2025.12.3", "2026.1.1"), true);
});

test("quiet window and the automatic decision", () => {
  const now = 10_000_000;
  assert.equal(isQuiet(null, now, 30), true);
  assert.equal(isQuiet(now - 29 * 60_000, now, 30), false);
  assert.equal(isQuiet(now - 30 * 60_000, now, 30), true);
  const base = { enabled: true, managed: true, current: "2026.9.2", latest: "2026.10.1", failedVersion: null, loginActive: false as boolean | null, quiet: true };
  assert.equal(autoUpdateDecision(base), "update");
  assert.equal(autoUpdateDecision({ ...base, enabled: false }), "off");
  assert.equal(autoUpdateDecision({ ...base, managed: false }), "not_managed");
  assert.equal(autoUpdateDecision({ ...base, current: "2026.10.1" }), "up_to_date");
  assert.equal(autoUpdateDecision({ ...base, latest: null }), "up_to_date");
  assert.equal(autoUpdateDecision({ ...base, failedVersion: "2026.10.1" }), "failed_before");
  assert.equal(autoUpdateDecision({ ...base, quiet: false }), "busy");
  assert.equal(autoUpdateDecision({ ...base, loginActive: true }), "login_active"); // a QR login wins over a quiet window
  assert.equal(autoUpdateDecision({ ...base, loginActive: null }), "login_unknown");
});

test("rollback decision after a swap", () => {
  assert.equal(healthVerdict({ running: true, health: "healthy" }, 1_000), "healthy");
  assert.equal(healthVerdict({ running: true, health: "starting" }, 60_000), "wait");
  assert.equal(healthVerdict({ running: true, health: "starting" }, 180_000), "rollback");
  assert.equal(healthVerdict({ running: true, health: "unhealthy" }, 20_000), "rollback");
  assert.equal(healthVerdict({ running: false, health: "starting" }, 1_000), "wait"); // just created
  assert.equal(healthVerdict({ running: false, health: null }, 6_000), "rollback"); // exited
  assert.equal(healthVerdict({ running: true, health: null }, 10_000), "wait"); // no healthcheck: must stay up
  assert.equal(healthVerdict({ running: true, health: null }, 15_000), "healthy");
});

/** A Docker stand-in that records every call and lets a test script the health of the new container. */
function fakeDocker(opts: { image?: string; health?: (n: number) => { running: boolean; health: string | null }; pullError?: string; none?: boolean } = {}) {
  const calls: string[] = [];
  const containers = new Map<string, ContainerInfo>();
  const old: ContainerInfo = { id: "old1", name: "floq-waha-1", image: opts.image ?? "devlikeapro/waha:noweb-2026.9.2", running: true, health: "healthy" };
  containers.set(old.id, old);
  let polls = 0, seq = 0;
  const d: WahaDocker = {
    available: () => true,
    find: async () => (opts.none ? null : [...containers.values()].find((c) => !c.name.includes("-floq-old-")) ?? null),
    inspect: async (id) => { const c = containers.get(id)!; if (id !== "old1" && opts.health) Object.assign(c, opts.health(polls++)); return { ...c }; },
    pull: async (repo, tag) => { calls.push(`pull ${repo}:${tag}`); if (opts.pullError) throw new Error(opts.pullError); },
    stop: async (id) => { calls.push("stop " + id); containers.get(id)!.running = false; },
    rename: async (id, name) => { calls.push(`rename ${id} ${name.replace(/\d{6,}/, "T")}`); containers.get(id)!.name = name; },
    createLike: async (o, image, name) => { const id = "new" + ++seq; calls.push(`create ${id} ${image}`); containers.set(id, { id, name, image, running: false, health: "starting" }); return id; },
    start: async (id) => { calls.push("start " + id); containers.get(id)!.running = true; },
    remove: async (id) => { calls.push("remove " + id); containers.delete(id); },
  };
  return { d, calls, containers, old };
}
const fast = { pollMs: 0, sleep: async () => undefined };

test("swap: a healthy new container replaces the old one, which is only deleted at the end", async () => {
  const f = fakeDocker({ health: (n) => ({ running: true, health: n < 2 ? "starting" : "healthy" }) });
  const r = await swapContainer(f.d, f.old, "devlikeapro/waha:noweb-2026.10.1", fast);
  assert.deepEqual(r, { ok: true, rolledBack: false, message: "Now running devlikeapro/waha:noweb-2026.10.1." });
  assert.deepEqual(f.calls, ["pull devlikeapro/waha:noweb-2026.10.1", "stop old1", "rename old1 floq-waha-1-floq-old-T", "create new1 devlikeapro/waha:noweb-2026.10.1", "start new1", "remove old1"]);
  assert.equal(f.containers.get("new1")!.name, "floq-waha-1");
});

test("swap: an unhealthy new container is removed and the previous one is started again under its name", async () => {
  const f = fakeDocker({ health: () => ({ running: true, health: "unhealthy" }) });
  const r = await swapContainer(f.d, f.old, "devlikeapro/waha:noweb-2026.10.1", fast);
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
  assert.match(r.message, /previous version \(devlikeapro\/waha:noweb-2026\.9\.2\) is running again/);
  assert.deepEqual(f.calls.slice(-3), ["remove new1", "rename old1 floq-waha-1", "start old1"]);
  assert.deepEqual([...f.containers.keys()], ["old1"]);
  assert.equal(f.containers.get("old1")!.running, true);
});

test("swap: a container that never becomes healthy is rolled back at the timeout; a failed pull changes nothing", async () => {
  let t = 0;
  const f = fakeDocker({ health: () => ({ running: true, health: "starting" }) });
  const r = await swapContainer(f.d, f.old, "devlikeapro/waha:noweb-2026.10.1", { ...fast, timeoutMs: 60_000, now: () => (t += 10_000) });
  assert.equal(r.rolledBack, true);
  const p = fakeDocker({ pullError: "manifest unknown" });
  const pr = await swapContainer(p.d, p.old, "devlikeapro/waha:noweb-2099.1.1", fast);
  assert.deepEqual({ ok: pr.ok, rolledBack: pr.rolledBack }, { ok: false, rolledBack: false });
  assert.deepEqual(p.calls, ["pull devlikeapro/waha:noweb-2099.1.1"]);
  assert.equal(p.containers.get("old1")!.running, true);
});

/** WAHA over a fake fetch: records which key went to which address. */
function fakeWaha(o: { version?: string; sessions?: { status: string }[]; key?: string; down?: boolean } = {}) {
  const seen: { url: string; key: string | null }[] = [];
  const f = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const key = init?.headers?.["X-Api-Key"] ?? null;
    seen.push({ url, key });
    if (o.down) throw new Error("ECONNREFUSED");
    if (key !== (o.key ?? KEY)) return new Response("{}", { status: 401 });
    if (url.endsWith("/api/server/version")) return Response.json({ version: o.version ?? "2026.9.2", engine: "NOWEB", tier: "CORE" });
    if (url.includes("/api/sessions")) return Response.json(o.sessions ?? [{ status: "WORKING" }]);
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, seen };
}
function service(o: { docker?: ReturnType<typeof fakeDocker>; waha?: ReturnType<typeof fakeWaha>; latest?: string | null; now?: () => number; plugin?: any; env?: Record<string, string> } = {}) {
  const notes: { title: string; body: string; level: string }[] = [];
  const docker = o.docker ?? fakeDocker({ health: () => ({ running: true, health: "healthy" }) });
  const waha = o.waha ?? fakeWaha();
  const s = new BuiltinWhatsapp({
    cfg: o.env ? builtinWhatsappFromEnv(o.env) : cfg(), docker: docker.d, fetchImpl: waha.f, now: o.now, latest: async () => (o.latest === undefined ? "2026.10.1" : o.latest),
    plugin: async () => o.plugin ?? { installed: true, enabled: true, mode: "builtin", external: null }, notify: async (n) => { notes.push(n); }, swap: fast,
  });
  return { s, notes, docker, waha };
}

test("status: running with version, a wrong key is 'unauthorized', a dead server 'unreachable'; nothing leaks the key", async () => {
  const ok = await service().s.status();
  assert.deepEqual(ok.builtin, { enabled: true, state: "running", version: "2026.9.2", engine: "NOWEB", tier: "CORE", image: "devlikeapro/waha:noweb-2026.9.2", managed: true });
  assert.deepEqual(ok.plugin, { installed: true, enabled: true, mode: "builtin" });
  assert.deepEqual(ok.autoUpdate, { enabled: true, quietMinutes: 30, lastCheckAt: null, last: null }); // on by default
  assert.ok(!JSON.stringify(ok).includes(KEY));
  assert.equal((await service({ waha: fakeWaha({ key: "another" }) }).s.status()).builtin.state, "unauthorized");
  const down = await service({ waha: fakeWaha({ down: true }) }).s;
  assert.equal((await down.status()).builtin.state, "unreachable");
  assert.deepEqual({ ...(await down.health()), checkedAt: "" }, { ok: false, state: "unreachable", latencyMs: null, version: null, error: "The server did not answer.", checkedAt: "" });
  const off = await service({ env: {} }).s.status();
  assert.equal(off.builtin.enabled, false); assert.equal(off.builtin.state, "off"); assert.equal(off.builtin.managed, false);
});

test("test connection: the built-in key never goes to another address", async () => {
  const { s, waha } = service();
  assert.equal((await s.test({ baseUrl: "", apiKey: "" })).ok, true);
  const ext = await s.test({ baseUrl: "https://waha.example.com/", apiKey: "" });
  assert.equal(ext.state, "unauthorized");
  assert.deepEqual(waha.seen.at(-1), { url: "https://waha.example.com/api/server/version", key: null });
  await s.test({ baseUrl: "https://waha.example.com", apiKey: "theirs" });
  assert.equal(waha.seen.at(-1)!.key, "theirs");
  assert.ok(waha.seen.filter((x) => !x.url.startsWith("http://waha:3000")).every((x) => x.key !== KEY));
  await assert.rejects(s.test({ baseUrl: "ftp://x", apiKey: "" }), { status: 400 });
  await assert.rejects(service({ env: {} }).s.test({ baseUrl: "", apiKey: "" }), { status: 400 });
});

test("manual update: waits for a quiet window unless forced, never runs during a QR login, keeps the tag flavor and remembers the release", async () => {
  let now = 1_000_000_000;
  const a = service({ now: () => now });
  await assert.rejects(a.s.applyUpdate("admin", false), { code: "whatsapp_busy" }); // the runtime just started: unknown counts as busy
  assert.deepEqual(a.docker.calls, []);
  const forced = await a.s.applyUpdate("admin", true);
  assert.match(forced.log, /noweb-2026\.10\.1/);
  assert.ok(a.docker.calls.includes("pull devlikeapro/waha:noweb-2026.10.1"));
  assert.deepEqual(a.notes.map((n) => [n.title, n.level]), [["WhatsApp server updated", "success"]]);
  const st = await a.s.status();
  assert.deepEqual({ ok: st.autoUpdate.last!.ok, from: st.autoUpdate.last!.from, to: st.autoUpdate.last!.to }, { ok: true, from: "2026.9.2", to: "2026.10.1" });
  await assert.rejects(a.s.applyUpdate("admin", true), { code: "up_to_date" });

  const b = service({ now: () => now, waha: fakeWaha({ sessions: [{ status: "WORKING" }, { status: "SCAN_QR_CODE" }] }) });
  await assert.rejects(b.s.applyUpdate("admin", true), { code: "whatsapp_login_active" }); // force does not skip this
  assert.deepEqual(b.docker.calls, []);

  const c = service({ now: () => now });
  now += 31 * 60_000;
  await c.s.applyUpdate("admin", false); // quiet for 31 minutes
  c.s.noteActivity();
  const d = service({ now: () => now, docker: fakeDocker({ none: true }) });
  await assert.rejects(d.s.applyUpdate("admin", true), { code: "not_managed" });
  const custom = service({ now: () => now, docker: fakeDocker({ image: "devlikeapro/waha:latest" }) });
  await assert.rejects(custom.s.applyUpdate("admin", true), { code: "not_managed" });
});

test("manual update that fails: rolled back, reported, and not retried automatically", async () => {
  let now = 1_000_000_000;
  const f = service({ now: () => now, docker: fakeDocker({ health: () => ({ running: true, health: "unhealthy" }) }) });
  await assert.rejects(f.s.applyUpdate("admin", true), { code: "update_failed" });
  assert.deepEqual(f.notes.map((n) => [n.title, n.level]), [["WhatsApp server update failed", "warning"]]);
  assert.equal((await f.s.status()).autoUpdate.last!.rolledBack, true);
  assert.equal((await f.s.status()).builtin.image, "devlikeapro/waha:noweb-2026.9.2");
  now += 2 * 24 * 3600_000;
  assert.equal(await f.s.tick(), "failed_before");
});

test("automatic update: once a day, only when quiet and no login is open; can be switched off", async () => {
  let now = 1_000_000_000;
  const a = service({ now: () => now });
  assert.equal(await a.s.tick(), "busy"); // activity (boot) inside the window
  a.s.noteActivity();
  now += 20 * 60_000;
  assert.equal(await a.s.tick(), "busy");
  now += 31 * 60_000;
  assert.equal(await a.s.tick(), "update");
  assert.equal(a.notes[0].title, "WhatsApp server updated");
  assert.equal((await a.s.status()).builtin.image, "devlikeapro/waha:noweb-2026.10.1");
  assert.equal(await a.s.tick(), "up_to_date");

  const q = service({ now: () => now + 3600_000, waha: fakeWaha({ sessions: [{ status: "SCAN_QR_CODE" }] }) });
  assert.equal(await q.s.tick(), "login_active");
  assert.deepEqual(q.docker.calls, []);

  const off = service({ now: () => now + 3600_000 });
  await off.s.setAutoUpdate({ enabled: false, quietMinutes: 5 });
  assert.equal(await off.s.tick(), "off");
  await assert.rejects(off.s.setAutoUpdate({ quietMinutes: 2 }), { status: 400 });
  await assert.rejects(off.s.setAutoUpdate({ enabled: "yes" }), { status: 400 });
});

test("redeploy: compose puts the pinned tag back, the runtime restores the release it had chosen; a newer pin is adopted", async () => {
  let now = 1_000_000_000;
  const rows: { data: string }[] = [];
  const pool = { query: async (sql: string, v?: unknown[]) => { if (sql.startsWith("INSERT")) rows[0] = { data: v![0] as string }; return { rows: sql.startsWith("SELECT") ? rows : [] }; } };
  const mk = (image: string) => {
    const docker = fakeDocker({ image, health: () => ({ running: true, health: "healthy" }) });
    const notes: unknown[] = [];
    return { docker, notes, s: new BuiltinWhatsapp({ cfg: cfg(), pool: pool as never, docker: docker.d, fetchImpl: fakeWaha().f, now: () => now, latest: async () => "2026.10.1", notify: async (n) => { notes.push(n); }, swap: fast }) };
  };
  const first = mk("devlikeapro/waha:noweb-2026.9.2");
  await first.s.applyUpdate("admin", true);
  assert.equal(JSON.parse(rows[0].data).tag, "noweb-2026.10.1");
  // A new runtime process after `docker compose up` recreated waha on the pinned 2026.9.2.
  const second = mk("devlikeapro/waha:noweb-2026.9.2");
  assert.equal(await second.s.reconcile(), "restored");
  assert.ok(second.docker.calls.includes("create new1 devlikeapro/waha:noweb-2026.10.1"));
  assert.deepEqual(second.notes, []); // a silent restore
  assert.equal(await second.s.reconcile(), "none");
  // The pin moved past what was stored: nothing to do but remember it.
  const third = mk("devlikeapro/waha:noweb-2026.11.1");
  assert.equal(await third.s.reconcile(), "adopted");
  assert.deepEqual(third.docker.calls, []);
  assert.equal(JSON.parse(rows[0].data).tag, "noweb-2026.11.1");
  // Another flavor (the admin moved to ARM) is never overwritten by a stored tag.
  rows[0] = { data: JSON.stringify({ tag: "noweb-2026.12.1" }) };
  const arm = mk("devlikeapro/waha:noweb-arm-2026.10.1");
  assert.equal(await arm.s.reconcile(), "adopted");
});

test("Settings > Updates: the built-in server is a managed target, an external WAHA is listed only", async () => {
  assert.equal(isUpdateTarget("whatsapp"), true);
  const builtin = await service().s.updateItem();
  assert.deepEqual(builtin, { target: "whatsapp", current: "2026.9.2", latest: "2026.10.1", updateAvailable: true, source: "github:devlikeapro/waha", managed: true });
  const waha = fakeWaha({ key: "theirs", version: "2026.8.1" });
  const ext = service({ env: {}, waha, plugin: { installed: true, enabled: true, mode: "external", external: { url: "https://waha.example.com", secret: "theirs" } } });
  assert.deepEqual(await ext.s.updateItem(), { target: "whatsapp", current: "2026.8.1", latest: "2026.10.1", updateAvailable: true, source: "github:devlikeapro/waha", managed: false });
  await assert.rejects(ext.s.applyUpdate("admin", true), { code: "not_managed" });
  assert.equal(await service({ env: {}, plugin: { installed: false, enabled: false, mode: "none", external: null } }).s.updateItem(), null);

  const calls: unknown[] = [];
  const port = { updateItem: async () => builtin, applyUpdate: async (actor: string, force: boolean) => { calls.push([actor, force]); return { log: "done" }; } };
  const updates = new UpdateService({ version: "1.0.0", providers: { claude: "true", codex: "true" }, repo: "x/y", runtimeDir: "/nonexistent", runtimeCommand: null, dockerSelfUpdate: false }, () => 3, () => undefined, port);
  const applied = await updates.apply("admin", { target: "whatsapp", force: true });
  assert.deepEqual(applied, { target: "whatsapp", ok: true, restarting: false, log: "done", activeSessions: 3 }); // running agents do not block it
  assert.deepEqual(calls, [["admin", true]]);
  const none = new UpdateService({ version: "1.0.0", providers: { claude: "true", codex: "true" }, repo: "x/y", runtimeDir: "/nonexistent", runtimeCommand: null }, () => 0);
  await assert.rejects(none.apply("admin", { target: "whatsapp" }), { code: "not_managed" });
});

test("docker-compose.yml: optional profile, pinned tag, no host port, no secrets, local media, named volumes", () => {
  const text = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const start = text.indexOf("\n  waha:\n"), end = text.indexOf("\n  runtime:\n");
  assert.ok(start > 0 && end > start);
  const waha = text.slice(start, end);
  assert.ok(waha.includes(`image: devlikeapro/waha:\${FLOQ_WHATSAPP_IMAGE_TAG:-${WAHA_PINNED_TAG}}`), "compose pin and WAHA_PINNED_TAG differ");
  assert.ok(parseWahaTag(WAHA_PINNED_TAG));
  assert.match(waha, /profiles: \["whatsapp"\]/);
  assert.ok(!/^\s+ports:/m.test(waha), "the WhatsApp server must not publish a host port");
  assert.match(waha, /WAHA_API_KEY: \$\{FLOQ_WHATSAPP_API_KEY:-\}/);
  assert.match(waha, /WAHA_DASHBOARD_ENABLED: "False"/);
  assert.match(waha, /WHATSAPP_SWAGGER_ENABLED: "False"/);
  assert.match(waha, /WHATSAPP_RESTART_ALL_SESSIONS: "True"/);
  assert.match(waha, /WAHA_MEDIA_STORAGE: LOCAL/);
  assert.ok(!/S3/.test(waha));
  assert.match(waha, /wahasessions:\/app\/\.sessions/);
  assert.match(waha, /healthcheck:/);
  assert.match(text.slice(end), /FLOQ_WHATSAPP_API_KEY: \$\{FLOQ_WHATSAPP_API_KEY:-\}/);
  assert.match(text, /\nvolumes:[\s\S]*\n  wahasessions:\n  wahamedia:/);
  // The runtime image never contains or starts WAHA.
  assert.ok(!/waha/i.test(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")));
});
