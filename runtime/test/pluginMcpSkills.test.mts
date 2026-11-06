import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, mcpInstallBody, mcpEntryName } from "../dist/plugins/host.js";
import { parseManifest } from "../dist/plugins/manifest.js";
import { badRequest } from "../dist/errors.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { SkillsService, PROTECTED_SKILLS } from "../dist/skills.js";
import { addToJsonConfig, addToTomlConfig, normalizeMcpInput } from "../dist/mcpConfig.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { echoManifest } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const SECRET_VALUE = "tok_must_never_be_written_123";

const mcpManifest = (over: Record<string, unknown> = {}) => echoManifest({
  id: "tix", name: "Tickets", scope: "user", secrets: [{ name: "TIX_TOKEN", required: true }],
  contributes: {
    migrations: false, skills: ["hello"],
    mcpServers: [
      { name: "api", type: "stdio", command: "tix-mcp", args: ["--stdio"], env: { REGION: "eu" }, envSecrets: { TIX_API_TOKEN: "TIX_TOKEN" } },
      { name: "web", type: "http", url: "https://mcp.tix.test/mcp", headers: { "X-Client": "floq" }, headerSecrets: { Authorization: "Bearer {{TIX_TOKEN}}" } },
    ],
  }, ...over,
});

test("install bodies hold only vault references; the written config has floq-vault wrappers and no values", () => {
  const m = parseManifest(mcpManifest());
  const [stdio, http] = m.contributes.mcpServers;
  const body = mcpInstallBody("tix", stdio) as any;
  assert.equal(body.name, "plugin-tix-api");
  assert.deepEqual(body.server.env, { REGION: "eu", TIX_API_TOKEN: "${vault:TIX_TOKEN}" });
  assert.equal(body.providers, "both");
  const spec = normalizeMcpInput(body.server, body.name);
  assert.deepEqual(spec.envSecrets, { TIX_API_TOKEN: "TIX_TOKEN" });
  for (const text of [addToJsonConfig(null, spec, "t"), addToTomlConfig(null, spec, "t")]) {
    assert.ok(text.includes("floq-vault"), text);
    assert.ok(!text.includes(SECRET_VALUE));
    assert.ok(text.includes("plugin-tix-api"));
  }
  const hbody = mcpInstallBody("tix", http) as any;
  assert.equal(hbody.providers, "claude"); // Codex cannot resolve secret headers
  assert.equal(hbody.server.headers.Authorization, "Bearer ${vault:TIX_TOKEN}");
  const hspec = normalizeMcpInput(hbody.server, hbody.name);
  assert.deepEqual(hspec.headerSecrets, { Authorization: "Bearer {{TIX_TOKEN}}" });
});

test("manifest refuses an MCP name that would exceed the installed-name limit", () => {
  assert.throws(() => parseManifest(mcpManifest({ id: "tix", contributes: { mcpServers: [{ name: "n".repeat(60), type: "stdio", command: "x" }] } })), /too long/);
});

function mcpHarness() {
  const calls: { op: string; userId: string; name: string; provider?: string; body?: any }[] = [];
  let failInstall = false;
  const port = {
    async install(userId: string, body: any) { if (failInstall) throw badRequest("Vault secret TIX_TOKEN does not exist.", "mcp_secret_missing"); calls.push({ op: "install", userId, name: body.name, body }); },
    async remove(userId: string, name: string, provider: string) { calls.push({ op: "remove", userId, name, provider }); },
  };
  return { calls, port, fail: (v: boolean) => { failInstall = v; } };
}

async function setup(skillsPort?: any) {
  const f = await fakePool(); await f.addUser("u1"); await f.addUser("u2"); await f.addUser("u3");
  const dir = mkdtempSync(join(tmpdir(), "plugin-"));
  mkdirSync(join(dir, "skills", "hello"), { recursive: true });
  writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello via the plugin\n---\n# Hello\n");
  const plugin = definePlugin({ manifest: mcpManifest(), dir });
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: { async reveal() { return {}; } } as never, sink: () => undefined });
  const h = mcpHarness();
  host.setMcp(h.port as never);
  if (skillsPort) host.setSkills(skillsPort);
  await host.load(); await host.enable("tix", "u1");
  const toggle = (userId: string, enabled: boolean) => host.handle({ userId, method: "PUT", pathname: "/v1/plugins/tix/user", query: new URLSearchParams(), readBody: async () => ({ enabled }), requireAdmin: async () => undefined }) as Promise<any>;
  return { ...f, host, h, toggle, dir };
}

test("user enable installs the plugin's servers for that user; disable removes exactly those entries", async () => {
  const { h, toggle } = await setup();
  assert.deepEqual(h.calls, []); // user scope: nothing is installed until a user switches it on
  const on = await toggle("u2", true);
  assert.deepEqual(h.calls.map((c) => [c.op, c.userId, c.name]), [["install", "u2", "plugin-tix-api"], ["install", "u2", "plugin-tix-web"]]);
  assert.equal(on.body.mcpProblems, undefined);
  h.calls.length = 0;
  await toggle("u2", false);
  assert.deepEqual(h.calls.map((c) => [c.op, c.userId, c.name, c.provider]), [
    ["remove", "u2", "plugin-tix-api", "claude"], ["remove", "u2", "plugin-tix-api", "codex"],
    ["remove", "u2", "plugin-tix-web", "claude"], ["remove", "u2", "plugin-tix-web", "codex"],
  ]);
  assert.ok(h.calls.every((c) => c.name === mcpEntryName("tix", c.name.replace("plugin-tix-", ""))));
});

test("an install failure (for example a missing secret) is reported but does not fail the toggle", async () => {
  const { h, toggle, host } = await setup();
  h.fail(true);
  const r = await toggle("u2", true);
  assert.equal(r.status, 200);
  assert.equal(r.body.plugin.userEnabled, true);
  assert.equal(r.body.mcpProblems.length, 2);
  assert.match(r.body.mcpProblems[0], /api: .*TIX_TOKEN/);
  assert.ok(!JSON.stringify(r.body).includes(SECRET_VALUE));
  assert.equal(host.statusOf("tix"), "enabled");
});

test("global disable removes entries for every user who had it on, and only them", async () => {
  const { h, toggle, host } = await setup();
  await toggle("u2", true); await toggle("u3", true); await toggle("u3", false);
  h.calls.length = 0;
  await host.disable("tix");
  const users = new Set(h.calls.map((c) => c.userId));
  assert.deepEqual([...users], ["u2"]);
  assert.equal(h.calls.length, 4);
});

function skillsService(skel: string) {
  const config = { skelDir: skel, preinstallSkills: true } as never;
  const pool = { query: async () => ({ rows: [] }) } as never;
  const shards = { awakeHandle: () => null } as never;
  return new SkillsService(config, shards, pool, (async () => { throw new Error("no shard"); }) as never);
}

test("plugin skills are published read-only into the bundled scope with a plugin origin; protected skills are untouched", async () => {
  const skel = mkdtempSync(join(tmpdir(), "skel-"));
  for (const name of PROTECTED_SKILLS) { mkdirSync(join(skel, ".claude", "skills", name), { recursive: true }); writeFileSync(join(skel, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: protected ${name}\n---\n`); }
  const skills = skillsService(skel);
  const before = (await skills.list("u1")).skills.map((s) => s.name).sort();
  const { host, dir } = await setup(skills);
  const after = (await skills.list("u1")).skills;
  const mine = after.filter((s) => s.origin === "plugin:tix");
  assert.deepEqual(mine.map((s) => [s.name, s.provider, s.source, s.location]).sort(), [["hello", "claude", "bundled", "plugin:tix/hello"], ["hello", "codex", "bundled", "plugin:tix/hello"]]);
  assert.deepEqual(after.filter((s) => s.origin !== "plugin:tix").map((s) => s.name).sort(), before);
  // readable through the normal file route
  const listing: any = await skills.readSkillFiles("u1", { scope: "global", provider: "claude", source: "bundled", location: "plugin:tix/hello" });
  assert.ok(listing.files.some((f: any) => f.path === "SKILL.md"));
  const file: any = await skills.readSkillFiles("u1", { scope: "global", provider: "claude", source: "bundled", location: "plugin:tix/hello", path: "SKILL.md" });
  assert.match(file.content, /Says hello/);
  // a location outside the declared folders is not readable
  await assert.rejects(skills.readSkillFiles("u1", { scope: "global", provider: "claude", source: "bundled", location: "plugin:tix/../x" }));
  // users cannot delete plugin skills; Floq's own stay protected
  await assert.rejects(skills.deleteSkill("u1", { provider: "claude", location: "plugin:tix/hello" }), (e: any) => e.status === 403);
  await assert.rejects(skills.deleteSkill("u1", { provider: "claude", location: ".claude/skills/floq-vault" }), (e: any) => e.status === 403);
  void dir;
  await host.disable("tix");
  const gone = (await skills.list("u1")).skills;
  assert.equal(gone.filter((s) => s.origin).length, 0);
  assert.deepEqual(gone.map((s) => s.name).sort(), before);
});

test("admin disable then enable reinstalls MCP servers for users who had the plugin on", async () => {
  const { h, toggle, host } = await setup();
  await toggle("u2", true);
  await host.disable("tix");
  h.calls.length = 0;
  await host.enable("tix", "u1");
  assert.deepEqual(h.calls.map((c) => [c.op, c.userId, c.name]), [["install", "u2", "plugin-tix-api"], ["install", "u2", "plugin-tix-web"]]);
});

test("plugin skills are copied into each user's agent home on enable and removed on disable", async () => {
  const calls: { op: string; userId: string; name: string; files?: Record<string, string> }[] = [];
  const port = {
    setPluginSkills() {},
    async installSkill(userId: string, name: string, files: Record<string, string>) { calls.push({ op: "install", userId, name, files }); },
    async removeSkill(userId: string, name: string) { calls.push({ op: "remove", userId, name }); },
  };
  const { host, toggle } = await setup(port);
  assert.deepEqual(calls, []); // user scope: nothing until a user switches it on
  const on = await toggle("u2", true);
  assert.deepEqual(calls.map((c) => [c.op, c.userId, c.name]), [["install", "u2", "hello"]]);
  assert.deepEqual(Object.keys(calls[0].files!).sort(), [".floq-plugin", "SKILL.md"]);
  assert.match(calls[0].files!["SKILL.md"], /name: hello/);
  assert.equal(on.body.mcpProblems, undefined);
  await toggle("u3", true); await toggle("u3", false);
  calls.length = 0;
  await host.disable("tix");
  assert.deepEqual(calls.map((c) => [c.op, c.userId, c.name]), [["remove", "u2", "hello"]]);
  calls.length = 0;
  await host.enable("tix", "u1"); // reinstalled for the user who still has it on
  assert.deepEqual(calls.map((c) => [c.op, c.userId, c.name]), [["install", "u2", "hello"]]);
});

test("a failing skill install is reported without failing the toggle; the shipped waha skill folder is readable", async () => {
  const { readSkillFolder } = await import("../dist/plugins/host.js");
  const { default: waha } = await import("../dist/plugins/waha/index.js");
  const files = readSkillFolder(waha.dir!, "waha");
  assert.deepEqual(Object.keys(files), ["SKILL.md"]);
  assert.match(files["SKILL.md"], /floq plugin call waha send/);
  const port = { setPluginSkills() {}, async installSkill() { throw badRequest("Skill package SKILL.md metadata is invalid", "invalid_skill_package"); } };
  const { toggle, host } = await setup(port);
  const r = await toggle("u2", true);
  assert.equal(r.status, 200);
  assert.match(r.body.mcpProblems.join(" "), /skill hello: Skill package SKILL.md metadata is invalid/);
  assert.equal(host.statusOf("tix"), "enabled");
});

test("installed skill copies carry an ownership marker, and removal is told which plugin it acts for", async () => {
  const { PLUGIN_MARKER } = await import("../dist/plugins/host.js");
  const calls: any[] = [];
  const port = { setPluginSkills() {}, async installSkill(u: string, n: string, files: Record<string, string>) { calls.push(["install", u, n, files]); }, async removeSkill(u: string, n: string, p: string) { calls.push(["remove", u, n, p]); } };
  const { host, toggle } = await setup(port);
  await toggle("u2", true);
  assert.deepEqual(JSON.parse(calls[0][3][PLUGIN_MARKER]), { pluginId: "tix", version: "1.0.0" });
  assert.ok("SKILL.md" in calls[0][3]);
  await host.disable("tix");
  assert.deepEqual(calls.at(-1), ["remove", "u2", "hello", "tix"]);
});

test("removal deletes only copies this plugin installed: a user's own skill of the same name survives", async () => {
  const { removeOwnedPluginSkill } = await import("../dist/plugins/skillOwnership.js");
  const { PLUGIN_MARKER } = await import("../dist/plugins/host.js");
  const deleted: string[] = [];
  const mk = (entries: any[], markers: Record<string, string | undefined>) => ({
    async list() { return { skills: entries }; },
    async readSkillFiles(_u: string, i: any) { assert.equal(i.path, PLUGIN_MARKER); const m = markers[`${i.provider}:${i.location}`]; if (m === undefined) throw new Error("no such file"); return { content: m }; },
    async deleteSkill(_u: string, i: any) { deleted.push(`${i.provider}:${i.location}`); },
  });
  const home = (provider: "claude" | "codex", location: string) => ({ name: "waha", source: "home", provider, location });
  const mine = JSON.stringify({ pluginId: "waha", version: "1.0.0" });
  // both provider copies carry our marker: both go
  let api = mk([home("claude", ".claude/skills/waha"), home("codex", ".agents/skills/waha")], { "claude:.claude/skills/waha": mine, "codex:.agents/skills/waha": mine });
  assert.equal(await removeOwnedPluginSkill(api as never, "u1", "waha", "waha"), 2);
  assert.deepEqual(deleted.splice(0), ["claude:.claude/skills/waha", "codex:.agents/skills/waha"]);
  // the user's own skill (no marker) survives; so does another plugin's copy, malformed markers, and anything with a marker for a different plugin
  api = mk([home("claude", ".claude/skills/waha"), home("codex", ".agents/skills/waha")], { "codex:.agents/skills/waha": JSON.stringify({ pluginId: "other" }) });
  assert.equal(await removeOwnedPluginSkill(api as never, "u1", "waha", "waha"), 0);
  api = mk([home("claude", ".claude/skills/waha")], { "claude:.claude/skills/waha": "not json" });
  assert.equal(await removeOwnedPluginSkill(api as never, "u1", "waha", "waha"), 0);
  assert.deepEqual(deleted, []);
  // a bundled skill of that name is never touched (deleting it would record a removal), and plugin-published list entries are ignored
  api = mk([{ name: "waha", source: "bundled", provider: "claude", location: ".claude/skills/waha" }, home("claude", ".claude/skills/waha"), { name: "waha", source: "bundled", provider: "claude", location: "plugin:waha/waha", origin: "plugin:waha" }], { "claude:.claude/skills/waha": mine });
  assert.equal(await removeOwnedPluginSkill(api as never, "u1", "waha", "waha"), 0);
  assert.deepEqual(deleted, []);
  // unrelated names are never considered
  api = mk([{ name: "other", source: "home", provider: "claude", location: ".claude/skills/other" }], { "claude:.claude/skills/other": mine });
  assert.equal(await removeOwnedPluginSkill(api as never, "u1", "waha", "waha"), 0);
});
