import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { fixture } from "./mcpFixture.mjs";

const SECRET = "sk-live-VERY-SECRET-123";

const done = (t, f) => t.after(() => rmSync(f.temp, { recursive: true, force: true }));
const stdio = (extra = {}) => ({ name: "files", type: "stdio", command: "npx", args: ["-y", "@scope/pkg"], ...extra });
const global = (extra) => ({ scope: "global", providers: ["claude"], server: stdio(), allowPlaintext: true, ...extra });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).filter((p) => statSync(join(dir, p)).isFile()).map((p) => [p, readFileSync(join(dir, p), "utf8")]));
function trySymlink(target, link, type) {
  try { symlinkSync(target, link, type); return true; } catch { return false; }
}

test("global Claude install merges into ~/.claude.json and keeps everything else", async (t) => {
  const f = fixture(); done(t, f);
  const original = { numStartups: 3, theme: "dark", projects: { "/x": { history: [1, 2] } }, mcpServers: { mine: { type: "http", url: "https://a.example/mcp", headers: { A: "b" } } } };
  writeFileSync(join(f.home, ".claude.json"), JSON.stringify(original, null, 2) + "\n");
  const result = await f.service.addMcp("owner", global({ server: stdio({ env: { API_KEY: SECRET } }) }));
  assert.equal(result.restartRequired, true);
  assert.deepEqual(result.servers, [{ name: "files", provider: "claude", scope: "global", source: "home", transport: "stdio", command: "npx" }]);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  const after = readJson(join(f.home, ".claude.json"));
  assert.equal(after.numStartups, 3);
  assert.deepEqual(after.projects, original.projects);
  assert.deepEqual(after.mcpServers.mine, original.mcpServers.mine);
  assert.deepEqual(after.mcpServers.files, { type: "stdio", command: "npx", args: ["-y", "@scope/pkg"], env: { API_KEY: SECRET } });
  assert.deepEqual(readdirSync(f.home).filter((n) => n.endsWith(".tmp")), []);
  // The listing shows the new server without any env value.
  const listed = await f.service.listMcp("owner", "global", undefined, "claude");
  assert.ok(listed.servers.some((s) => s.name === "files" && s.source === "home"));
  assert.ok(!JSON.stringify(listed).includes(SECRET));
});

test("a new ~/.claude.json and ~/.codex/config.toml are created when absent; both providers install together", async (t) => {
  const f = fixture(); done(t, f);
  const result = await f.service.addMcp("owner", { scope: "global", providers: "both", allowPlaintext: true, server: { name: "web", type: "http", url: "https://e.example/mcp", headers: { Authorization: "Bearer " + SECRET } } });
  assert.deepEqual(result.servers.map((s) => s.provider).sort(), ["claude", "codex"]);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(readJson(join(f.home, ".claude.json")).mcpServers.web, { type: "http", url: "https://e.example/mcp", headers: { Authorization: "Bearer " + SECRET } });
  const toml = parseToml(readFileSync(join(f.home, ".codex", "config.toml"), "utf8"));
  assert.equal(toml.mcp_servers.web.url, "https://e.example/mcp");
  assert.equal(toml.mcp_servers.web.http_headers.Authorization, "Bearer " + SECRET);
});

test("Codex install keeps comments and other settings", async (t) => {
  const f = fixture(); done(t, f);
  mkdirSync(join(f.home, ".codex"));
  const original = '# mine\nmodel = "o3" # keep\n\n[mcp_servers.old]\ncommand = "old"\n';
  writeFileSync(join(f.home, ".codex", "config.toml"), original);
  await f.service.addMcp("owner", global({ providers: ["codex"], server: stdio({ env: { K: SECRET } }) }));
  const after = readFileSync(join(f.home, ".codex", "config.toml"), "utf8");
  assert.ok(after.startsWith(original));
  assert.equal(parseToml(after).mcp_servers.files.env.K, SECRET);
});

test("duplicate names conflict and leave the file byte-identical; bundled names are protected", async (t) => {
  const f = fixture(); done(t, f);
  await f.service.addMcp("owner", global());
  const before = snapshot(f.home);
  await assert.rejects(f.service.addMcp("owner", global({ server: stdio({ name: "FILES", env: { K: SECRET } }) })), (e) => e.status === 409 && e.code === "mcp_exists" && !e.message.includes(SECRET));
  await assert.rejects(f.service.addMcp("owner", global({ server: stdio({ name: "context7" }) })), (e) => e.status === 409 && e.code === "mcp_protected");
  await assert.rejects(f.service.addMcp("owner", global({ providers: ["codex"], server: stdio({ name: "context7" }) })), (e) => e.code === "mcp_protected");
  assert.deepEqual(snapshot(f.home), before);
});

test("a malformed existing config is refused and left unchanged; nothing is leaked", async (t) => {
  const f = fixture(); done(t, f);
  const bad = '{"mcpServers": {"a": ' + JSON.stringify(SECRET);
  writeFileSync(join(f.home, ".claude.json"), bad);
  await assert.rejects(f.service.addMcp("owner", global({ server: stdio({ env: { K: SECRET } }) })), (e) => e.status === 400 && e.code === "mcp_config_malformed" && !e.message.includes(SECRET));
  assert.equal(readFileSync(join(f.home, ".claude.json"), "utf8"), bad);
  mkdirSync(join(f.home, ".codex"));
  writeFileSync(join(f.home, ".codex", "config.toml"), 'key = "' + SECRET + '\n[oops');
  await assert.rejects(f.service.addMcp("owner", global({ providers: ["codex"] })), (e) => e.code === "mcp_config_malformed" && !e.message.includes(SECRET));
  assert.ok(readFileSync(join(f.home, ".codex", "config.toml"), "utf8").includes("[oops"));
});

test("installing for both providers is all-or-nothing when one config is malformed", async (t) => {
  const f = fixture(); done(t, f);
  mkdirSync(join(f.home, ".codex"));
  writeFileSync(join(f.home, ".codex", "config.toml"), "[broken");
  await assert.rejects(f.service.addMcp("owner", { scope: "global", providers: "both", server: stdio() }), (e) => e.code === "mcp_config_malformed");
  assert.ok(!existsSync(join(f.home, ".claude.json")));
});

test("invalid names, URLs, scopes and providers are rejected before anything is written", async (t) => {
  const f = fixture(); done(t, f);
  const before = snapshot(f.home);
  for (const server of [stdio({ name: "../x" }), stdio({ name: "a/b" }), stdio({ name: "" }), stdio({ command: "npx -y x" }), { name: "w", type: "http", url: "file:///etc/passwd" }, { name: "w", type: "http", url: "https://u:p@e.example/" }]) {
    await assert.rejects(f.service.addMcp("owner", global({ server })), (e) => e.status === 400);
  }
  await assert.rejects(f.service.addMcp("owner", global({ scope: "everywhere" })), /scope/);
  await assert.rejects(f.service.addMcp("owner", global({ providers: ["claude", "claude"] })), /providers/);
  await assert.rejects(f.service.addMcp("owner", global({ providers: ["gemini"] })), /providers/);
  assert.deepEqual(snapshot(f.home), before);
});

test("dry run validates and describes without touching the home", async (t) => {
  const f = fixture(); done(t, f);
  const result = await f.service.addMcp("owner", global({ dryRun: true, server: stdio({ env: { K: SECRET } }) }));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.installed, { name: "files", type: "stdio", summary: "npx -y @scope/pkg", envNames: ["K"], headerNames: [], secrets: [], plaintext: ["K"] });
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!existsSync(join(f.home, ".claude.json")));
});

test("symlinked config files and directories are refused and their targets untouched", async (t) => {
  const f = fixture(); done(t, f);
  const outside = join(f.temp, "outside.json");
  writeFileSync(outside, '{"keep":true}');
  if (!trySymlink(outside, join(f.home, ".claude.json"), "file")) { t.skip("symlinks unavailable on this host"); return; }
  await assert.rejects(f.service.addMcp("owner", global()), (e) => e.status === 400 && e.code === "mcp_config_unsafe");
  assert.equal(readFileSync(outside, "utf8"), '{"keep":true}');
  const elsewhere = join(f.temp, "elsewhere");
  mkdirSync(elsewhere);
  trySymlink(elsewhere, join(f.home, ".codex"), "dir");
  await assert.rejects(f.service.addMcp("owner", global({ providers: ["codex"] })), (e) => e.code === "mcp_config_unsafe");
  assert.deepEqual(readdirSync(elsewhere), []);
  await assert.rejects(f.service.removeMcp("owner", { scope: "global", provider: "claude", name: "files" }), (e) => e.code === "mcp_config_unsafe");
});

test("project scope writes .mcp.json and .codex/config.toml in the project checkout only", async (t) => {
  const f = fixture(); done(t, f);
  const result = await f.service.addMcp("owner", { scope: "project", projectId: "p1", providers: "both", allowPlaintext: true, server: stdio({ env: { K: SECRET } }) });
  assert.deepEqual(result.servers.map((s) => [s.provider, s.scope, s.source]).sort(), [["claude", "project", "project"], ["codex", "project", "project"]]);
  assert.equal(readJson(join(f.repo, ".mcp.json")).mcpServers.files.env.K, SECRET);
  assert.equal(parseToml(readFileSync(join(f.repo, ".codex", "config.toml"), "utf8")).mcp_servers.files.env.K, SECRET);
  assert.ok(!existsSync(join(f.home, ".claude.json")) && !existsSync(join(f.home, ".codex")));
  const listed = await f.service.listMcp("owner", "project", "p1");
  assert.equal(listed.servers.filter((s) => s.name === "files").length, 2);
  assert.ok(!JSON.stringify(listed).includes(SECRET));
});

test("another user's project, a missing project and a missing projectId are refused", async (t) => {
  const f = fixture(); done(t, f);
  const before = snapshot(f.home);
  await assert.rejects(f.service.addMcp("intruder", { scope: "project", projectId: "p1", providers: ["claude"], server: stdio() }), (e) => e.status === 404);
  await assert.rejects(f.service.removeMcp("intruder", { scope: "project", projectId: "p1", provider: "claude", name: "files" }), (e) => e.status === 404);
  await assert.rejects(f.service.addMcp("owner", { scope: "project", projectId: "nope", providers: ["claude"], server: stdio() }), (e) => e.status === 404);
  await assert.rejects(f.service.addMcp("owner", { scope: "project", providers: ["claude"], server: stdio() }), /projectId/);
  assert.deepEqual(snapshot(f.home), before);
});

test("remove deletes exactly one entry and nothing else", async (t) => {
  const f = fixture(); done(t, f);
  const original = { theme: "dark", mcpServers: { keep: { type: "stdio", command: "k", args: [] } } };
  writeFileSync(join(f.home, ".claude.json"), JSON.stringify(original, null, 2));
  await f.service.addMcp("owner", global({ server: stdio({ env: { K: SECRET } }) }));
  const result = await f.service.removeMcp("owner", { scope: "global", provider: "claude", name: "files" });
  assert.equal(result.removed, 1);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(readJson(join(f.home, ".claude.json")), original);
  await assert.rejects(f.service.removeMcp("owner", { scope: "global", provider: "claude", name: "files" }), (e) => e.status === 404);
  await assert.rejects(f.service.removeMcp("owner", { scope: "global", provider: "claude", name: "keep\nx" }), (e) => e.status === 400);
});

test("bundled servers cannot be removed, even when a copy was seeded into the home", async (t) => {
  const f = fixture(); done(t, f);
  writeFileSync(join(f.home, ".claude.json"), readFileSync(join(f.bundle, ".claude.json")));
  const before = snapshot(f.home);
  await assert.rejects(f.service.removeMcp("owner", { scope: "global", provider: "claude", name: "context7" }), (e) => e.status === 403);
  await assert.rejects(f.service.removeMcp("owner", { scope: "global", provider: "codex", name: "Context7" }), (e) => e.status === 403);
  assert.deepEqual(snapshot(f.home), before);
  const listed = await f.service.listMcp("owner", "global");
  assert.ok(listed.servers.filter((s) => s.name === "context7").every((s) => s.protected === true));
});

test("removing a global Codex server also removes it from this user's per-session Codex homes", async (t) => {
  const f = fixture(); done(t, f);
  await f.service.addMcp("owner", global({ providers: ["codex"] }));
  const sessionHome = join(f.home, ".floq", "codex", "sess-1");
  mkdirSync(sessionHome, { recursive: true });
  writeFileSync(join(sessionHome, "config.toml"), '# session\n[mcp_servers.files]\ncommand = "npx"\n\n[mcp_servers.context7]\ncommand = "npx"\n');
  const result = await f.service.removeMcp("owner", { scope: "global", provider: "codex", name: "files" });
  assert.equal(result.removed, 2);
  const session = readFileSync(join(sessionHome, "config.toml"), "utf8");
  assert.ok(session.includes("# session") && session.includes("context7") && !session.includes("files"));
  assert.ok(!readFileSync(join(f.home, ".codex", "config.toml"), "utf8").includes("files"));
});

test("project removal leaves the other provider's file alone", async (t) => {
  const f = fixture(); done(t, f);
  await f.service.addMcp("owner", { scope: "project", projectId: "p1", providers: "both", server: stdio() });
  const codexBefore = readFileSync(join(f.repo, ".codex", "config.toml"), "utf8");
  await f.service.removeMcp("owner", { scope: "project", projectId: "p1", provider: "claude", name: "files" });
  assert.deepEqual(readJson(join(f.repo, ".mcp.json")), { mcpServers: {} });
  assert.equal(readFileSync(join(f.repo, ".codex", "config.toml"), "utf8"), codexBefore);
});

test("new config files are private and an existing file keeps its mode", async (t) => {
  if (process.platform === "win32") { t.skip("POSIX modes"); return; }
  const f = fixture(); done(t, f);
  await f.service.addMcp("owner", global());
  assert.equal(statSync(join(f.home, ".claude.json")).mode & 0o777, 0o600);
  chmodSync(join(f.home, ".claude.json"), 0o640);
  await f.service.addMcp("owner", global({ server: stdio({ name: "second" }) }));
  assert.equal(statSync(join(f.home, ".claude.json")).mode & 0o777, 0o640);
});

test("removing a skill by name reuses the protected delete path", async (t) => {
  const f = fixture(); done(t, f);
  mkdirSync(join(f.home, ".claude", "skills", "mine"), { recursive: true });
  writeFileSync(join(f.home, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\nbody");
  mkdirSync(join(f.bundle, ".claude", "skills", "floq-vault"), { recursive: true });
  writeFileSync(join(f.bundle, ".claude", "skills", "floq-vault", "SKILL.md"), "---\nname: floq-vault\ndescription: d\n---\nbody");
  f.service.pool = { query: async () => ({ rows: [] }) };
  await assert.rejects(f.service.removeSkillByName("owner", "floq-vault"), (e) => e.status === 403 && e.code === "skill_protected");
  assert.equal((await f.service.removeSkillByName("owner", "mine")).removed, 1);
  assert.ok(!existsSync(join(f.home, ".claude", "skills", "mine")));
  await assert.rejects(f.service.removeSkillByName("owner", "mine"), (e) => e.status === 404);
});
