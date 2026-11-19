import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";
import { Orchestrator } from "../dist/orchestrator.js";
import { encryptSecret } from "../dist/crypto.js";
import { fixture } from "./mcpFixture.mjs";
import { cleanSecretInput, formatMcpReview, parseArgs, scopeFields, splitDashDash } from "../dist/image/floq-args.mjs";

const SECRET = "tok_live_9f8e7d6c5b4a_SHOULD_NEVER_APPEAR";
const FLOQ = fileURLToPath(new URL("../dist/image/floq.mjs", import.meta.url));
const key = Buffer.alloc(32, 9);
const P1 = "11111111-1111-4111-8111-111111111111";

// Sessions: s-lead (claude lead in project P1), s-member (claude, not lead), s-codex (codex lead), s-other (another user's lead).
// A plain shell session has no row because agent rows exclude shells, exactly like `floq list`.
const SESSIONS = [
  { id: "s-lead", user_id: "owner", title: "Lead", provider: "claude", model: null, state: "running", lead: true, cwd: "repo", git_url: null, project_cwd: "repo", project_id: P1, workspace_id: null },
  { id: "s-member", user_id: "owner", title: "Member", provider: "claude", model: null, state: "running", lead: false, cwd: "repo", git_url: null, project_cwd: "repo", project_id: P1, workspace_id: null },
  { id: "s-codex", user_id: "owner", title: "CodexLead", provider: "codex", model: null, state: "running", lead: true, cwd: null, git_url: null, project_cwd: null, project_id: null, workspace_id: null },
  { id: "s-other", user_id: "other", title: "Other", provider: "claude", model: null, state: "running", lead: true, cwd: "x", git_url: null, project_cwd: "x", project_id: "22222222-2222-4222-8222-222222222222", workspace_id: null },
];

async function freePort() {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function harness(t) {
  const vaultRows = new Map();
  const audits = [];
  const statements = [];
  const projectRow = (sql, params) => (/FROM floq_projects/.test(sql) ? (params[0] === P1 && params[1] === "owner" ? { rows: [{ cwd: "repo" }] } : { rows: [] }) : undefined);
  const extra = async (sql, params) => {
    statements.push({ sql, params });
    if (/FROM floq_projects/.test(sql)) return projectRow(sql, params);
    if (/FROM agent_sessions/.test(sql)) return { rows: SESSIONS.filter((row) => row.user_id === params[0]) };
    if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ n: [...vaultRows.values()].filter((r) => r.user_id === params[0]).length }] };
    if (/INSERT INTO vault_secrets/.test(sql)) {
      const [user_id, name, description, value_enc] = params.length === 4 ? params : [params[0], params[1], params[2], params[4]];
      if (vaultRows.has(user_id + name)) { const error = new Error("duplicate key"); error.code = "23505"; throw error; }
      vaultRows.set(user_id + name, { user_id, name, description, expose: "tool", value_enc, created_at: new Date(), updated_at: new Date(), last_used_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM vault_secrets WHERE user_id = \$1 ORDER BY name|SELECT name, description, expose/.test(sql)) return { rows: [...vaultRows.values()].filter((r) => r.user_id === params[0]) };
    if (/SELECT name, value_enc FROM vault_secrets WHERE user_id = \$1 AND expose = \$2/.test(sql)) return { rows: [...vaultRows.values()].filter((r) => r.user_id === params[0] && r.expose === params[1]) };
    if (/INTO vault_audit/.test(sql)) { audits.push(params); return { rows: [] }; }
    return undefined;
  };
  const f = fixture(extra);
  // The fixture's service pool is the same fake, so the vault and orchestrator can share its statements.
  const pool = { query: async (sql, params) => (await extra(sql, params)) ?? (/collaboration\.organizations/.test(sql) ? { rows: [{ id: "00000000-0000-4000-8000-0000000000aa" }] } : { rows: [] }), connect: async () => { throw new Error("unused"); } };
  const vault = new Vault(pool, { encryptionKey: key });
  const orchestrator = new Orchestrator(pool, {}, {});
  const restartCalls = [];
  const manager = {
    activeCount: 0,
    projectCreates: [],
    async createProject(userId, profile, gitUrl, name) {
      this.projectCreates.push({ userId, profile, gitUrl, name });
      return { id: "project-created", name: name ?? "repo", displayName: null, imageUrl: null, gitUrl: gitUrl ?? null, cwd: ".floq/projects/project-created", createdAt: new Date(0).toISOString(), workspaces: [{ id: "workspace-created", cwd: ".floq/projects/project-created", name: "Main", branch: null, isWorktree: false, navExpanded: true, sessionIds: [] }] };
    },
    async assertSelfRestartable(userId, sessionId) { restartCalls.push({ kind: "preflight", userId, sessionId }); },
    async restartSelf(userId, profile, sessionId) { restartCalls.push({ kind: "restart", userId, profile, sessionId }); },
  };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "info" };
  const server = createRuntimeServer({ config, manager, auth: { handler() {}, api: { async getSession() { return { user: { id: "owner" }, session: { id: "app-session" } }; } } }, settings: { async profile(userId) { return { userId }; } }, github: {}, vault, orchestrator, pool, credentials: {}, claudeOauth: {}, usage: {}, skills: f.service, gitReview: {} });
  await server.listen();
  t.after(async () => { await server.close(); rmSync(f.temp, { recursive: true, force: true }); });
  const tokens = Object.fromEntries(SESSIONS.map((s) => [s.id, vault.issueToken(s.user_id, s.id)]));
  tokens.shell = vault.issueToken("owner", "s-shell"); // a plain shell: token issued, but no agent row
  const call = async (session, path, body = {}, token = tokens[session]) => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/${path}`, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const callApp = async (path, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  return { f, call, callApp, vaultRows, audits, statements, port, tokens, vault, restartCalls, manager };
}

function captureLogs(t) {
  const lines = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return out(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return err(chunk, ...rest); };
  t.after(() => { process.stdout.write = out; process.stderr.write = err; });
  return lines;
}

test("an invalid or missing token is rejected on every toolkit route", async (t) => {
  const h = await harness(t);
  for (const path of ["skills/list", "mcp/list", "mcp/add", "mcp/remove", "secrets/add", "skills/remove", "agents/restart"]) {
    assert.equal((await h.call("s-lead", path, {}, "not-a-token")).status, 401, path);
  }
  const bare = await fetch(`http://127.0.0.1:${h.port}/internal/mcp/list`, { method: "POST", body: "{}" });
  assert.equal(bare.status, 401);
});

test("session restart is self-scoped, available to non-leads, and starts only after the response flushes", async (t) => {
  const h = await harness(t);
  const get = await fetch(`http://127.0.0.1:${h.port}/internal/agents/restart`, { method: "GET", headers: { Authorization: "Bearer " + h.tokens["s-member"] } });
  assert.equal(get.status, 405, "the restart endpoint cannot be triggered by a GET request");
  assert.equal(h.restartCalls.length, 0);
  const wrongTarget = await h.call("s-member", "agents/restart", { sessionId: "s-lead" });
  assert.equal(wrongTarget.status, 400);
  assert.equal(h.restartCalls.length, 0);

  const shell = await h.call("shell", "agents/restart");
  assert.equal(shell.status, 404, "plain shell tokens cannot restart an agent session");
  const response = await h.call("s-member", "agents/restart");
  assert.equal(response.status, 202);
  assert.equal(response.json.scheduled, true);
  assert.equal(h.restartCalls.filter((call) => call.kind === "restart").length, 0, "restart is deferred until after the HTTP response");
  assert.deepEqual(h.restartCalls[0], { kind: "preflight", userId: "owner", sessionId: "s-member" });
  await new Promise((resolve) => setTimeout(resolve, response.json.restartDelayMs + 100));
  assert.deepEqual(h.restartCalls[1], { kind: "restart", userId: "owner", profile: { userId: "owner" }, sessionId: "s-member" });
});

test("changes need a lead session; reading and dry runs do not", async (t) => {
  const h = await harness(t);
  const spec = { config: { name: "files", command: "npx", args: ["-y", "pkg"] } };
  for (const [path, body] of [["mcp/add", spec], ["mcp/remove", { name: "files" }], ["skills/remove", { name: "x" }], ["skills/add", { url: "https://github.com/o/r/blob/main/s/SKILL.md" }]]) {
    const r = await h.call("s-member", path, body);
    assert.equal(r.status, 403, path);
    assert.equal(r.json.error.code, "not_lead");
    assert.ok(!r.text.includes(SECRET));
  }
  assert.equal((await h.call("s-member", "mcp/list")).status, 200);
  assert.equal((await h.call("s-member", "skills/list")).status, 200);
  const dry = await h.call("s-member", "mcp/add", { ...spec, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assert.ok(!existsSync(join(h.f.repo, ".mcp.json")));
  assert.equal(h.vaultRows.size, 0);
});

test("a plain shell session is refused like for floq list, but the vault listing still works", async (t) => {
  const h = await harness(t);
  for (const path of ["mcp/list", "skills/list", "mcp/add", "secrets/add"]) {
    const r = await h.call("shell", path, { config: { name: "a", command: "x" }, name: "A_B", value: SECRET });
    assert.equal(r.status, 404, path);
  }
  assert.equal((await h.call("shell", "vault/secrets")).status, 200);
  assert.equal(h.vaultRows.size, 0);
});

test("a lead installs into its own project by default, with its own provider, and the answer carries no values", async (t) => {
  const h = await harness(t);
  const r = await h.call("s-lead", "mcp/add", { allowPlaintext: true, config: { name: "files", command: "npx", args: ["-y", "pkg"], env: { API_KEY: SECRET } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.scope, "project");
  assert.equal(r.json.projectId, P1);
  assert.deepEqual(r.json.servers.map((s) => s.provider), ["claude"]);
  assert.deepEqual(r.json.installed, { name: "files", type: "stdio", summary: "npx -y pkg", envNames: ["API_KEY"], headerNames: [], secrets: [], plaintext: ["API_KEY"] });
  assert.ok(!r.text.includes(SECRET));
  assert.equal(JSON.parse(readFileSync(join(h.f.repo, ".mcp.json"), "utf8")).mcpServers.files.env.API_KEY, SECRET);
  assert.ok(!existsSync(join(h.f.home, ".claude.json")));
  // duplicate
  const again = await h.call("s-lead", "mcp/add", { config: { name: "files", command: "npx" } });
  assert.equal(again.status, 409);
  assert.ok(!again.text.includes(SECRET));
  // list is redacted
  const listed = await h.call("s-lead", "mcp/list");
  assert.ok(listed.json.servers.some((s) => s.name === "files"));
  assert.ok(!listed.text.includes(SECRET));
  // remove
  const removed = await h.call("s-lead", "mcp/remove", { name: "files" });
  assert.equal(removed.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(h.f.repo, ".mcp.json"), "utf8")), { mcpServers: {} });
});

test("a session without a project defaults to global; --global and --project override; codex uses its own file", async (t) => {
  const h = await harness(t);
  const codex = await h.call("s-codex", "mcp/add", { config: { name: "web", type: "http", url: "https://e.example/mcp" } });
  assert.equal(codex.status, 200, codex.text);
  assert.equal(codex.json.scope, "global");
  assert.deepEqual(codex.json.servers.map((s) => s.provider), ["codex"]);
  assert.ok(readFileSync(join(h.f.home, ".codex", "config.toml"), "utf8").includes("[mcp_servers.web]"));
  const none = await h.call("s-codex", "mcp/add", { scope: "project", config: { name: "x", command: "x" } });
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, "no_project");
  const globalFromProject = await h.call("s-lead", "mcp/add", { scope: "global", providers: "both", config: { name: "both", command: "x" } });
  assert.equal(globalFromProject.status, 200);
  assert.deepEqual(globalFromProject.json.servers.map((s) => s.provider).sort(), ["claude", "codex"]);
  assert.ok(existsSync(join(h.f.home, ".claude.json")));
});

test("a project that belongs to another user is refused, whether named or defaulted", async (t) => {
  const h = await harness(t);
  const named = await h.call("s-other", "mcp/add", { scope: "project", projectId: P1, config: { name: "evil", command: "x" } });
  assert.equal(named.status, 404);
  const defaulted = await h.call("s-other", "mcp/add", { config: { name: "evil", command: "x" } }); // its own project row does not exist in floq_projects for this user
  assert.equal(defaulted.status, 404);
  const list = await h.call("s-other", "mcp/list", { scope: "project", projectId: P1 });
  assert.equal(list.status, 404);
  const skills = await h.call("s-other", "skills/list", { scope: "project", projectId: P1 });
  assert.equal(skills.status, 404);
  assert.ok(!existsSync(join(h.f.repo, ".mcp.json")));
});

test("bundled MCP servers are protected through the CLI route too", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("s-lead", "mcp/remove", { scope: "global", provider: "claude", name: "context7" })).status, 403);
  assert.equal((await h.call("s-lead", "mcp/add", { scope: "global", config: { name: "context7", command: "x" } })).status, 409);
});

test("skills: list, add into the project from a GitHub SKILL.md URL, protected skills refused on remove", async (t) => {
  const h = await harness(t);
  mkdirSync(join(h.f.bundle, ".claude", "skills", "floq-vault"), { recursive: true });
  writeFileSync(join(h.f.bundle, ".claude", "skills", "floq-vault", "SKILL.md"), "---\nname: floq-vault\ndescription: d\n---\nbody");
  const prior = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).startsWith("https://raw.githubusercontent.com/") ? new Response("---\nname: demo\ndescription: A demo\n---\nbody\n") : prior(url, init);
  t.after(() => { globalThis.fetch = prior; });
  const added = await h.call("s-lead", "skills/add", { url: "https://github.com/o/r/blob/main/skills/demo/SKILL.md" });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.projectId, P1);
  assert.equal(added.json.skill.provider, "claude");
  assert.ok(existsSync(join(h.f.repo, ".claude", "skills", "demo", "SKILL.md")));
  const listed = await h.call("s-member", "skills/list", { scope: "project" });
  assert.ok(listed.json.skills.some((s) => s.name === "demo"));
  const again = await h.call("s-lead", "skills/add", { url: "https://github.com/o/r/blob/main/skills/demo/SKILL.md" });
  assert.equal(again.status, 409);
  const global = await h.call("s-lead", "skills/add", { scope: "global", url: "https://github.com/o/r/blob/main/skills/demo/SKILL.md" });
  assert.equal(global.status, 200, global.text);
  assert.ok(existsSync(join(h.f.home, ".claude", "skills", "demo", "SKILL.md")));
  const foreign = await h.call("s-other", "skills/add", { projectId: P1, url: "https://github.com/o/r/blob/main/skills/demo/SKILL.md" });
  assert.equal(foreign.status, 404);
  const protectedRemove = await h.call("s-lead", "skills/remove", { name: "floq-vault" });
  assert.equal(protectedRemove.status, 403);
  assert.equal(protectedRemove.json.error.code, "skill_protected");
  assert.equal((await h.call("s-lead", "skills/remove", { name: "nonexistent" })).status, 404);
});

test("keychain secret endpoints are gone; the vault is the only secret store agents can read", async (t) => {
  const h = await harness(t);
  for (const action of ["secrets/add", "secrets/names", "secrets/pull"]) {
    const r = await h.call("s-lead", action, { name: "STRIPE_KEY", value: SECRET });
    assert.equal(r.status, 404, action);
    assert.ok(!r.text.includes(SECRET));
  }
  assert.equal(h.vaultRows.size, 0, "nothing was written to the vault");
});

test("vault secrets exposed as env still reach the agent; tool-only ones do not", async (t) => {
  const h = await harness(t);
  const seed = (name, value, expose) => h.vaultRows.set("owner" + name, { user_id: "owner", name, description: null, expose, value_enc: encryptSecret(key, value, "owner:vault:" + name), created_at: new Date(), updated_at: new Date(), last_used_at: null });
  seed("ENV_TOKEN", SECRET, "env");
  seed("TOOL_TOKEN", SECRET + "-tool", "tool");
  const global = await h.call("s-member", "secrets/global");
  assert.equal(global.status, 200, global.text);
  assert.deepEqual(global.json.secrets, { ENV_TOKEN: SECRET });
  assert.ok(!global.text.includes("TOOL_TOKEN"));
});

// ---- the CLI itself ----

function runFloq(h, args, { input, token, tty } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FLOQ, ...args], { env: { PATH: process.env.PATH, FLOQ_API_URL: `http://127.0.0.1:${h.port}`, FLOQ_AGENT_TOKEN: token ?? h.tokens["s-lead"] } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

test("floq session restart explains the delayed same-session restart", async (t) => {
  const h = await harness(t);
  const result = await runFloq(h, ["session", "restart"], { token: h.tokens["s-member"] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Restart scheduled/);
  assert.match(result.stdout, /same session and conversation/);
  assert.match(result.stdout, /does not authenticate an MCP server/);
  assert.equal(h.restartCalls.filter((call) => call.kind === "restart").length, 0, "the CLI exits before its own PTY restart begins");
  const invalid = await runFloq(h, ["session", "restart", "s-lead"]);
  assert.equal(invalid.code, 2, "CLI does not accept a target session ID");
});

test("app and agent project creation share validation and user-scoped manager creation", async (t) => {
  const h = await harness(t);
  const missing = await h.callApp("/v1/projects", {});
  assert.equal(missing.status, 400);
  assert.equal(h.manager.projectCreates.length, 0);

  const appProject = await h.callApp("/v1/projects", { name: "  Personal  " });
  assert.equal(appProject.status, 201, appProject.text);
  assert.equal(appProject.json.project.id, "project-created");
  assert.deepEqual(h.manager.projectCreates[0], { userId: "owner", profile: { userId: "owner" }, gitUrl: undefined, name: "Personal" });

  const agentProject = await h.call("s-other", "projects/create", { name: "Imported", gitUrl: "https://example.test/team/repo.git" });
  assert.equal(agentProject.status, 201, agentProject.text);
  assert.deepEqual(h.manager.projectCreates[1], { userId: "other", profile: { userId: "other" }, gitUrl: "https://example.test/team/repo.git", name: "Imported" });

  const invalid = await h.call("s-lead", "projects/create", { name: "  " });
  assert.equal(invalid.status, 400);
  const nonLead = await h.call("s-member", "projects/create", { name: "Nope" });
  assert.equal(nonLead.status, 403);
  assert.equal(nonLead.json.error.code, "not_lead");
  const unauthorized = await h.call("s-member", "projects/create", { name: "Nope" }, "not-a-token");
  assert.equal(unauthorized.status, 401);
  assert.equal(h.manager.projectCreates.length, 2);
});

test("floq project create requires a trimmed name and reports the created project path", async (t) => {
  const h = await harness(t);
  const created = await runFloq(h, ["project", "create", "--name", "  Research Hub  "]);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /project-created/);
  assert.match(created.stdout, /\.floq\/projects\/project-created/);
  assert.deepEqual(h.manager.projectCreates[0], { userId: "owner", profile: { userId: "owner" }, gitUrl: undefined, name: "Research Hub" });

  const imported = await runFloq(h, ["project", "create", "--git-url", "https://example.test/team/repo.git"]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.deepEqual(h.manager.projectCreates[1], { userId: "owner", profile: { userId: "owner" }, gitUrl: "https://example.test/team/repo.git", name: undefined });

  const help = await runFloq(h, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /floq project create --name NAME \[--git-url URL\]/);

  for (const args of [["project", "create"], ["project", "create", "--name", " "], ["project", "create", "--name", "x".repeat(121)], ["project", "create", "--git-url", " "], ["project", "create", "--name", "ok", "--unknown"]]) {
    const rejected = await runFloq(h, args);
    assert.equal(rejected.code, 2, args.join(" "));
  }
  assert.equal(h.manager.projectCreates.length, 2, "invalid CLI invocations do not reach the API");
});

test("floq secrets add creates create-only tool secrets from stdin or --generate; floq secret list/get read env-exposed vault entries", async (t) => {
  const h = await harness(t);
  const seed = (name, value, expose) => h.vaultRows.set("owner" + name, { user_id: "owner", name, description: null, expose, value_enc: encryptSecret(key, value, "owner:vault:" + name), created_at: new Date(), updated_at: new Date(), last_used_at: null });
  const requestsBefore = h.statements.length;
  // Refused locally, nothing sent: a value as an argument, the old keychain flag, a bad name, an empty stdin.
  for (const [args, input] of [[["secrets", "add", "OTHER_KEY", SECRET], ""], [["secrets", "add", "OTHER_KEY", "--keychain", "Pay"], SECRET + "\n"], [["secret", "get", "X", "--keychain", "Pay"], ""], [["secrets", "add", "lower_case"], SECRET + "\n"], [["secrets", "add", "EMPTY_ONE"], "\n"]]) {
    const r = await runFloq(h, args, { input });
    assert.equal(r.code, 2, args.join(" "));
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  }
  assert.equal(h.statements.length, requestsBefore, "no request was sent for refused invocations");
  const added = await runFloq(h, ["secrets", "add", "OTHER_KEY", "--description", "Pay API"], { input: SECRET + "\n" });
  assert.equal(added.code, 0, added.stderr);
  assert.ok(!added.stdout.includes(SECRET) && !added.stderr.includes(SECRET));
  const row = h.vaultRows.get("ownerOTHER_KEY");
  assert.ok(row, "the secret was stored");
  assert.equal(row.expose, "tool", "agent-created secrets are tool-only");
  assert.ok(!String(row.value_enc).includes(SECRET), "stored encrypted");
  const dup = await runFloq(h, ["secrets", "add", "OTHER_KEY"], { input: "other\n" });
  assert.notEqual(dup.code, 0, "create-only: an existing name is refused");
  const gen = await runFloq(h, ["secrets", "add", "GEN_TOKEN", "--generate"]);
  assert.equal(gen.code, 0, gen.stderr);
  assert.match(gen.stdout, /generated value, never shown/);
  assert.equal(h.vaultRows.get("ownerGEN_TOKEN")?.expose, "tool");
  const listedTool = await runFloq(h, ["secret", "list"]);
  assert.ok(!listedTool.stdout.includes("OTHER_KEY") && !listedTool.stdout.includes("GEN_TOKEN"), "tool-only secrets are not readable by agents");
  seed("DB_PASSWORD", SECRET, "env");
  const list = await runFloq(h, ["secret", "list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /DB_PASSWORD/);
  assert.ok(!list.stdout.includes(SECRET));
  assert.ok(!/keychain/i.test(list.stdout));
  const got = await runFloq(h, ["secret", "get", "DB_PASSWORD"]);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.stdout, SECRET);
  assert.equal((await runFloq(h, ["secret", "get", "MISSING_ONE"])).code, 1);
});

test("floq mcp add shows exactly what runs, masks env values, and --dry-run changes nothing", async (t) => {
  const h = await harness(t);
  const dry = await runFloq(h, ["mcp", "add", "files", "--dry-run", "--", "npx", "-y", "@scope/pkg", "--dir", "/data dir"], { token: h.tokens["s-member"] });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /Would install MCP server "files" \(stdio\)/);
  assert.match(dry.stdout, /runs:  npx -y @scope\/pkg --dir "\/data dir"/);
  assert.match(dry.stdout, /runs this command with the agent's permissions/);
  assert.match(dry.stdout, /dry run: nothing was changed/);
  assert.ok(!existsSync(join(h.f.repo, ".mcp.json")));
  const json = JSON.stringify({ mcpServers: { api: { command: "node", args: ["server.js"], env: { API_KEY: SECRET } } } });
  const real = await runFloq(h, ["mcp", "add", "--json", "-", "--global", "--provider", "both", "--allow-plaintext"], { input: json });
  assert.equal(real.code, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /stored as plain text in the config file: API_KEY=\*\*\*\* \(values hidden\)/);
  assert.match(real.stdout, /scope: global/);
  assert.ok(!real.stdout.includes(SECRET) && !real.stderr.includes(SECRET));
  assert.equal(JSON.parse(readFileSync(join(h.f.home, ".claude.json"), "utf8")).mcpServers.api.env.API_KEY, SECRET);
  const listed = await runFloq(h, ["mcp", "list", "--global"]);
  assert.match(listed.stdout, /claude\tapi\tstdio\tnode/);
  assert.match(listed.stdout, /context7.*bundled, protected/);
  assert.ok(!listed.stdout.includes(SECRET));
  const removed = await runFloq(h, ["mcp", "remove", "api", "--global", "--provider", "claude"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /floq session restart/);
  const protectedRemove = await runFloq(h, ["mcp", "remove", "context7", "--global", "--provider", "claude"]);
  assert.equal(protectedRemove.code, 1);
  assert.match(protectedRemove.stderr, /bundled/);
});

test("argument parsing: --project optional UUID, --global, `--` split, secrets add rules", () => {
  assert.deepEqual(parseArgs(["a", "--project"]).named, { project: true });
  assert.deepEqual(parseArgs(["a", "--project", P1, "b"]), { positional: ["a", "b"], named: { project: P1 } });
  assert.deepEqual(parseArgs(["files", "--project", "files2"]).positional, ["files", "files2"]);
  assert.deepEqual(parseArgs(["--global", "x"]), { positional: ["x"], named: { global: true } });
  assert.deepEqual(splitDashDash(["add", "n", "--", "npx", "-y", "--flag"]), [["add", "n"], ["npx", "-y", "--flag"]]);
  assert.deepEqual(splitDashDash(["add", "n"]), [["add", "n"], null]);
  assert.deepEqual(scopeFields({}), {});
  assert.deepEqual(scopeFields({ global: true }), { scope: "global" });
  assert.deepEqual(scopeFields({ project: true }), { scope: "project" });
  assert.deepEqual(scopeFields({ project: P1 }), { scope: "project", projectId: P1 });
  assert.throws(() => scopeFields({ global: true, project: true }), /either/);
  assert.equal(cleanSecretInput("abc\n"), "abc");
  assert.equal(cleanSecretInput("abc\r\n"), "abc");
  assert.equal(cleanSecretInput("a\nb\n"), "a\nb");
  assert.match(formatMcpReview({ name: "n", type: "http", summary: "https://e.com/x", envNames: [], headerNames: ["Authorization"], secrets: [{ target: "X-Key", secret: "MY_TOKEN" }], plaintext: ["Authorization"] }, { scope: "project", projectId: P1 }), /X-Key <- vault secret MY_TOKEN[\s\S]*Authorization=\*\*\*\*[\s\S]*committed to git/);
});

test("floq mcp add: vault references work, unknown ones and plain credentials are refused, dry run lists secret names only", async (t) => {
  const h = await harness(t);
  await h.vault.create("owner", "s-lead", { name: "STRIPE_KEY", value: SECRET, description: "payments" });
  const ref = { config: { name: "pay", command: "npx", args: ["-y", "pay-mcp"], env: { TOKEN: "${vault:STRIPE_KEY}", NODE_ENV: "ci" } }, scope: "global" };
  const dry = await h.call("s-member", "mcp/add", { ...ref, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(dry.json.installed.secrets, [{ target: "TOKEN", secret: "STRIPE_KEY" }]);
  assert.ok(!dry.text.includes(SECRET));
  assert.ok(!existsSync(join(h.f.home, ".claude.json")));
  const unknown = await h.call("s-lead", "mcp/add", { ...ref, config: { ...ref.config, env: { TOKEN: "${vault:NOPE_KEY}" } } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, "mcp_secret_missing");
  const literal = await h.call("s-lead", "mcp/add", { ...ref, config: { name: "lit", command: "npx", env: { API_KEY: SECRET } } });
  assert.equal(literal.status, 400);
  assert.equal(literal.json.error.code, "mcp_plaintext_secret");
  assert.ok(!literal.text.includes(SECRET));
  const real = await h.call("s-lead", "mcp/add", ref);
  assert.equal(real.status, 200, real.text);
  const file = readFileSync(join(h.f.home, ".claude.json"), "utf8");
  assert.ok(file.includes("floq-vault") && file.includes("TOKEN=STRIPE_KEY") && !file.includes(SECRET));
  const member = await h.call("s-member", "mcp/add", { ...ref, config: { ...ref.config, name: "other" } });
  assert.equal(member.status, 403);
  const cli = await runFloq(h, ["mcp", "list", "--global", "--provider", "claude"]);
  assert.match(cli.stdout, /claude\tpay\tstdio\tnpx\t\(uses vault secrets: STRIPE_KEY\)/);
});

test("vault run (server-side injection): non-lead is refused, bad argv is rejected, and no cleartext route result carries a secret (RA-03)", async (t) => {
  const h = await harness(t);
  const member = await h.call("s-member", "vault/run", { names: ["ANY_SECRET"], argv: ["true"] });
  assert.equal(member.status, 403);
  assert.equal(member.json.error.code, "not_lead");
  const bad = await h.call("s-lead", "vault/run", { names: ["ANY_SECRET"], argv: [] });
  assert.equal(bad.status, 400);
  const noSandbox = await h.call("s-lead", "vault/run", { names: [], argv: ["true"] });
  assert.equal(noSandbox.status, 503);
});

test("vault reveal: non-lead agents cannot bulk reveal or read tool-only secrets (RA-03)", async (t) => {
  const h = await harness(t);
  const bulk = await h.call("s-member", "vault/reveal", {});
  assert.equal(bulk.status, 403);
  assert.equal(bulk.json.error.code, "not_lead");
  const named = await h.call("s-member", "vault/reveal", { names: ["ANY_SECRET"] });
  assert.equal(named.status, 403);
  assert.equal(named.json.error.code, "not_lead");
});
