import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";
import { Orchestrator } from "../dist/orchestrator.js";
import { addToJsonConfig, addToTomlConfig, normalizeMcpInput, specSecretNames, vaultUsage } from "../dist/mcpConfig.js";
import { fixture } from "./mcpFixture.mjs";

const VALUE = "sk-live-NEVER-IN-CONFIG-0001";
const HEADER_VALUE = "tok-live-NEVER-IN-CONFIG-0002";
const key = Buffer.alloc(32, 5);
const P1 = "11111111-1111-4111-8111-111111111111";
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------- the config that gets written ----------

test("a vault reference is written as a floq-vault wrapper and the value is nowhere in the file (Claude)", () => {
  const spec = normalizeMcpInput({ name: "files", command: "npx", args: ["-y", "@scope/pkg"], env: { API_KEY: "${vault:FILES_API_KEY}", NODE_ENV: "production" } });
  assert.deepEqual(spec.envSecrets, { API_KEY: "FILES_API_KEY" });
  assert.deepEqual(spec.env, { NODE_ENV: "production" });
  assert.deepEqual(specSecretNames(spec), ["FILES_API_KEY"]);
  const entry = JSON.parse(addToJsonConfig(null, spec, "c")).mcpServers.files;
  assert.deepEqual(entry, {
    type: "stdio", command: "/usr/local/bin/floq-vault",
    args: ["run", "--stdio", "--only", "FILES_API_KEY", "--map", "API_KEY=FILES_API_KEY", "--", "npx", "-y", "@scope/pkg"],
    env: { NODE_ENV: "production" },
  });
  assert.ok(!JSON.stringify(entry).includes("${vault"));
});

test("Codex gets the same wrapper plus env_vars so the wrapper can reach the runtime", () => {
  const spec = normalizeMcpInput({ name: "files", command: "npx", args: ["-y", "pkg"], env: { A: "${vault:ONE_KEY}", B: "${vault:TWO_KEY}", C: "${vault:ONE_KEY}" } });
  const table = plain(parseToml(addToTomlConfig(null, spec, "c")).mcp_servers.files);
  assert.equal(table.command, "/usr/local/bin/floq-vault");
  assert.deepEqual(table.args, ["run", "--stdio", "--only", "ONE_KEY,TWO_KEY", "--map", "A=ONE_KEY", "--map", "B=TWO_KEY", "--map", "C=ONE_KEY", "--", "npx", "-y", "pkg"]);
  assert.deepEqual(table.env_vars, ["FLOQ_API_URL", "FLOQ_AGENT_TOKEN"]);
  assert.equal(table.env, undefined);
});

test("servers without vault references are written exactly as before (no wrapper, no env_vars)", () => {
  const spec = normalizeMcpInput({ name: "plain", command: "npx", env: { NODE_ENV: "x" } });
  assert.deepEqual(plain(parseToml(addToTomlConfig(null, spec, "c")).mcp_servers.plain), { command: "npx", args: [], env: { NODE_ENV: "x" } });
  assert.deepEqual(JSON.parse(addToJsonConfig(null, spec, "c")).mcpServers.plain, { type: "stdio", command: "npx", args: [], env: { NODE_ENV: "x" } });
});

test("HTTP header references become a headersHelper for Claude; Codex refuses instead of writing plain text", () => {
  const spec = normalizeMcpInput({ name: "web", type: "http", url: "https://e.example/mcp", headers: { Authorization: "Bearer ${vault:WEB_TOKEN}", "X-Static": "1" } });
  assert.deepEqual(spec.headerSecrets, { Authorization: "Bearer {{WEB_TOKEN}}" });
  const entry = JSON.parse(addToJsonConfig(null, spec, "c")).mcpServers.web;
  assert.equal(entry.type, "http");
  assert.deepEqual(entry.headers, { "X-Static": "1" });
  assert.match(entry.headersHelper, /^\/usr\/local\/bin\/floq-vault headers --server web --spec [A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(entry.headersHelper.split("--spec ")[1], "base64url").toString()), { Authorization: "Bearer {{WEB_TOKEN}}" });
  assert.ok(!JSON.stringify(entry).includes("${vault"));
  assert.throws(() => addToTomlConfig(null, spec, "c"), (e) => e.status === 400 && e.code === "mcp_secret_unsupported");
});

test("malformed or half-way references are rejected, never written", () => {
  for (const env of [{ A: "prefix-${vault:NAME}" }, { A: "${vault:lower}" }, { A: "${vault:NAME}${vault:TWO}" }, { A: "${vault:}" }]) {
    assert.throws(() => normalizeMcpInput({ name: "x", command: "c", env }), (e) => e.status === 400, JSON.stringify(env));
  }
  assert.throws(() => normalizeMcpInput({ name: "x", type: "http", url: "https://e.example", headers: { A: "{{SNEAKY}} ${vault:OK_NAME}" } }), (e) => e.status === 400);
});

test("the wrapper is recognised again when listing: original command, secret names, no values", () => {
  const spec = normalizeMcpInput({ name: "files", command: "npx", args: ["-y", "pkg"], env: { API_KEY: "${vault:FILES_API_KEY}" } });
  const entry = JSON.parse(addToJsonConfig(null, spec, "c")).mcpServers.files;
  assert.deepEqual(vaultUsage(entry.command, entry.args, undefined), { command: "npx", secretNames: ["FILES_API_KEY"] });
  const web = JSON.parse(addToJsonConfig(null, normalizeMcpInput({ name: "web", type: "http", url: "https://e.example", headers: { A: "${vault:WEB_TOKEN}" } }), "c")).mcpServers.web;
  assert.deepEqual(vaultUsage(undefined, undefined, web.headersHelper), { secretNames: ["WEB_TOKEN"] });
  assert.equal(vaultUsage("npx", ["-y", "pkg"], undefined), null);
  assert.equal(vaultUsage("/usr/local/bin/floq-vault", ["list"], undefined), null);
});

// ---------- the service and the app route ----------

async function freePort() {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function harness(t, { existing = {} } = {}) {
  const vaultRows = new Map(Object.entries(existing).map(([name, description]) => [name, { user_id: "owner", name, description, expose: "tool", value_enc: "enc", created_at: new Date(), updated_at: new Date(), last_used_at: null }]));
  const audits = [];
  const extra = async (sql, params) => {
    if (/FROM floq_projects/.test(sql)) return params[0] === P1 && params[1] === "owner" ? { rows: [{ cwd: "repo" }] } : { rows: [] };
    if (/FROM agent_sessions/.test(sql)) return { rows: [] };
    if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ n: vaultRows.size }] };
    if (/INSERT INTO vault_secrets/.test(sql)) {
      if (vaultRows.has(params[1])) { const error = new Error("duplicate key"); error.code = "23505"; throw error; }
      vaultRows.set(params[1], { user_id: params[0], name: params[1], description: params[2], expose: "tool", value_enc: params[3], created_at: new Date(), updated_at: new Date(), last_used_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM vault_secrets/.test(sql)) return { rows: [], rowCount: vaultRows.delete(params[1]) ? 1 : 0 };
    if (/SELECT name, description, expose/.test(sql)) return { rows: [...vaultRows.values()] };
    if (/INTO vault_audit/.test(sql)) { audits.push(params); return { rows: [] }; }
    return undefined;
  };
  const f = fixture(extra);
  const pool = { query: async (sql, params) => (await extra(sql, params)) ?? { rows: [] }, connect: async () => { throw new Error("unused"); } };
  const vault = new Vault(pool, { encryptionKey: key });
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "info" };
  const auth = { handler() {}, api: { getSession: async () => ({ user: { id: "owner" } }) } };
  const server = createRuntimeServer({ config, manager: {}, auth, settings: {}, github: {}, vault, orchestrator: new Orchestrator(pool, {}, {}), pool, credentials: {}, claudeOauth: {}, usage: {}, skills: f.service, gitReview: {} });
  await server.listen();
  t.after(async () => { await server.close(); rmSync(f.temp, { recursive: true, force: true }); });
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const configText = () => {
    const files = [join(f.home, ".claude.json"), join(f.home, ".codex", "config.toml"), join(f.repo, ".mcp.json"), join(f.repo, ".codex", "config.toml")];
    return files.filter(existsSync).map((p) => readFileSync(p, "utf8")).join("\n");
  };
  return { f, post, vaultRows, audits, configText };
}

test("a new secret typed in the dialog is saved to the vault and the config holds only a reference", async (t) => {
  const h = await harness(t);
  const r = await h.post("/v1/mcp", {
    scope: "global", providers: "both",
    server: { name: "files", type: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_KEY: "${vault:FILES_API_KEY}", NODE_ENV: "production" } },
    newSecrets: [{ name: "FILES_API_KEY", value: VALUE, description: "Used by MCP server files (API_KEY)" }],
  });
  assert.equal(r.status, 201, r.text);
  assert.ok(!r.text.includes(VALUE));
  assert.deepEqual(r.json.servers.map((s) => [s.provider, s.usesSecrets, s.secretNames]), [["claude", true, ["FILES_API_KEY"]], ["codex", true, ["FILES_API_KEY"]]]);
  assert.ok(h.vaultRows.has("FILES_API_KEY"));
  assert.equal(h.vaultRows.get("FILES_API_KEY").expose, "tool");
  assert.ok(!h.vaultRows.get("FILES_API_KEY").value_enc.includes(VALUE));
  assert.ok(h.audits.some((a) => a[2] === "FILES_API_KEY" && a[3] === "create"));
  const text = h.configText();
  assert.ok(text.includes("FILES_API_KEY") && text.includes("floq-vault") && text.includes("NODE_ENV"));
  assert.ok(!text.includes(VALUE), "the value is absent from every config file");
  const list = await h.f.service.listMcp("owner", "global");
  const claude = list.servers.find((s) => s.name === "files" && s.provider === "claude");
  assert.deepEqual({ command: claude.command, usesSecrets: claude.usesSecrets, secretNames: claude.secretNames }, { command: "npx", usesSecrets: true, secretNames: ["FILES_API_KEY"] });
  assert.ok(!JSON.stringify(list).includes(VALUE));
});

test("picking an existing secret creates nothing, and a missing one is refused with nothing written", async (t) => {
  const h = await harness(t, { existing: { STRIPE_KEY: "payments" } });
  const ok = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "a", type: "stdio", command: "npx", env: { TOKEN: "${vault:STRIPE_KEY}" } }, newSecrets: [] });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(h.vaultRows.size, 1);
  const before = h.configText();
  const missing = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "b", type: "stdio", command: "npx", env: { TOKEN: "${vault:NOPE_KEY}" } } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, "mcp_secret_missing");
  assert.equal(h.configText(), before);
});

test("a new secret whose name is taken is a conflict: nothing is overwritten and no config is written", async (t) => {
  const h = await harness(t, { existing: { FILES_API_KEY: "mine" } });
  const r = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "files", type: "stdio", command: "npx", env: { API_KEY: "${vault:FILES_API_KEY}" } }, newSecrets: [{ name: "FILES_API_KEY", value: VALUE }] });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "secret_exists");
  assert.ok(!r.text.includes(VALUE));
  assert.equal(h.vaultRows.get("FILES_API_KEY").value_enc, "enc", "existing secret untouched");
  assert.equal(h.configText(), "");
});

test("if writing the config fails, only the secrets created by this attempt are removed", async (t) => {
  const h = await harness(t, { existing: { KEEP_ME: "pre-existing" } });
  const first = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "files", type: "stdio", command: "npx" } });
  assert.equal(first.status, 201);
  const before = h.configText();
  const r = await h.post("/v1/mcp", {
    scope: "global", providers: ["claude"], server: { name: "files", type: "stdio", command: "npx", env: { A_KEY: "${vault:ONE_NEW}", B_KEY: "${vault:KEEP_ME}" } },
    newSecrets: [{ name: "ONE_NEW", value: VALUE }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "mcp_exists");
  assert.ok(!h.vaultRows.has("ONE_NEW"), "the secret created for the failed attempt is gone");
  assert.ok(h.vaultRows.has("KEEP_ME"), "a secret that existed before is never touched");
  assert.equal(h.configText(), before);
  assert.ok(h.audits.some((a) => a[2] === "ONE_NEW" && a[3] === "create") && h.audits.some((a) => a[2] === "ONE_NEW" && a[3] === "delete"));
});

test("a bad request creates no secrets at all (validated before anything is created)", async (t) => {
  const h = await harness(t);
  const r = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "bad name!", type: "stdio", command: "npx", env: { K: "${vault:NEW_ONE}" } }, newSecrets: [{ name: "NEW_ONE", value: VALUE }] });
  assert.equal(r.status, 400);
  assert.equal(h.vaultRows.size, 0);
  const reserved = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "ok", type: "stdio", command: "npx", env: { K: "${vault:PATH}" } }, newSecrets: [{ name: "PATH", value: VALUE }] });
  assert.equal(reserved.status, 400);
  assert.equal(h.vaultRows.size, 0);
  assert.ok(!reserved.text.includes(VALUE));
});

test("Codex plus an HTTP header secret is refused for 'both' and for Codex, but works for Claude only", async (t) => {
  const h = await harness(t, { existing: { WEB_TOKEN: "t" } });
  const server = { name: "web", type: "http", url: "https://e.example/mcp", headers: { Authorization: "Bearer ${vault:WEB_TOKEN}" } };
  for (const providers of ["both", ["codex"]]) {
    const r = await h.post("/v1/mcp", { scope: "global", providers, server });
    assert.equal(r.status, 400, JSON.stringify(providers));
    assert.equal(r.json.error.code, "mcp_secret_unsupported");
  }
  assert.equal(h.configText(), "");
  const ok = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server });
  assert.equal(ok.status, 201, ok.text);
  assert.ok(JSON.parse(readFileSync(join(h.f.home, ".claude.json"), "utf8")).mcpServers.web.headersHelper.includes("floq-vault headers"));
});

test("credential-looking literals are refused unless plain text is allowed explicitly; project config can hold references", async (t) => {
  const h = await harness(t, { existing: { STRIPE_KEY: "payments" } });
  const literal = { scope: "global", providers: ["claude"], server: { name: "lit", type: "stdio", command: "npx", env: { API_KEY: VALUE } } };
  const refused = await h.post("/v1/mcp", literal);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, "mcp_plaintext_secret");
  assert.ok(!refused.text.includes(VALUE));
  assert.equal(h.configText(), "");
  assert.equal((await h.post("/v1/mcp", { ...literal, allowPlaintext: true })).status, 201);
  assert.ok(h.configText().includes(VALUE), "an explicit plain text value is stored where the user was told");
  const project = await h.post("/v1/mcp", { scope: "project", projectId: P1, providers: "both", server: { name: "proj", type: "stdio", command: "npx", env: { TOKEN: "${vault:STRIPE_KEY}", NODE_ENV: "ci" } } });
  assert.equal(project.status, 201, project.text);
  const projectFiles = [join(h.f.repo, ".mcp.json"), join(h.f.repo, ".codex", "config.toml")].map((p) => readFileSync(p, "utf8")).join("\n");
  assert.ok(projectFiles.includes("STRIPE_KEY") && !projectFiles.includes(VALUE), "the repository only ever sees a reference");
});

test("removing a server keeps its vault secrets", async (t) => {
  const h = await harness(t);
  await h.post("/v1/mcp", { scope: "global", providers: ["claude"], server: { name: "files", type: "stdio", command: "npx", env: { API_KEY: "${vault:FILES_API_KEY}" } }, newSecrets: [{ name: "FILES_API_KEY", value: VALUE }] });
  const result = await h.f.service.removeMcp("owner", { scope: "global", provider: "claude", name: "files" });
  assert.equal(result.removed, 1);
  assert.ok(h.vaultRows.has("FILES_API_KEY"));
  assert.ok(!h.configText().includes("files"));
});

test("the CLI route accepts references, refuses unknown ones and literal credentials, and dry-run names secrets without values", async (t) => {
  const h = await harness(t, { existing: { STRIPE_KEY: "payments" } });
  // The CLI route needs an agent session; add a lead through the shared fixture's pool by posting to the internal route is covered in floqToolkit.test.mjs.
  // Here the service-level contract the CLI route relies on is checked through the same app route with dryRun.
  const dry = await h.post("/v1/mcp", { scope: "global", providers: ["claude"], dryRun: true, server: { name: "files", type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "${vault:STRIPE_KEY}", NODE_ENV: "x" } } });
  assert.equal(dry.status, 201, dry.text);
  assert.deepEqual(dry.json.installed.secrets, [{ target: "TOKEN", secret: "STRIPE_KEY" }]);
  assert.deepEqual(dry.json.installed.plaintext, ["NODE_ENV"]);
  assert.equal(h.configText(), "");
  assert.equal(h.vaultRows.size, 1);
});
