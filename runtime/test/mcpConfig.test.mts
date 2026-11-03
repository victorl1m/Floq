import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseToml } from "smol-toml";
import {
  addToJsonConfig, addToTomlConfig, describeMcp, mergeGlobalCodexMcp, normalizeMcpInput, removeFromJsonConfig, removeFromTomlConfig,
} from "../dist/mcpConfig.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const stdio = (extra = {}) => ({ name: "files", command: "npx", args: ["-y", "@scope/pkg", "--dir", "/data dir"], ...extra });

test("accepts each pasted JSON shape", () => {
  const wrapped = normalizeMcpInput({ mcpServers: { files: { command: "npx", args: ["-y", "x"], env: { KEY: "v" } } } });
  assert.deepEqual(wrapped, { name: "files", type: "stdio", command: "npx", args: ["-y", "x"], env: { KEY: "v" }, headers: {}, envSecrets: {}, headerSecrets: {}, plaintextSensitive: ["KEY"] });
  assert.equal(normalizeMcpInput({ servers: { files: { command: "npx" } } }).name, "files");
  const bare = normalizeMcpInput({ files: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer abc" } } });
  assert.deepEqual(bare, { name: "files", type: "http", url: "https://example.com/mcp", args: [], env: {}, headers: { Authorization: "Bearer abc" }, envSecrets: {}, headerSecrets: {}, plaintextSensitive: ["Authorization"] });
  const named = normalizeMcpInput({ name: "files", command: "node", args: ["a.js"] });
  assert.equal(named.command, "node");
  assert.equal(normalizeMcpInput(JSON.stringify({ mcpServers: { a: { url: "http://localhost:3000/mcp" } } })).type, "http");
  assert.equal(normalizeMcpInput({ command: "node" }, "override").name, "override");
  assert.equal(normalizeMcpInput({ type: "streamable-http", url: "https://e.com/x" }, "e").type, "http");
});

test("rejects unsafe or unsupported input with clear errors", () => {
  const bad = (input, pattern, name) => assert.throws(() => normalizeMcpInput(input, name), (error) => error.status === 400 && pattern.test(error.message), JSON.stringify(input));
  bad({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }, /2 servers/);
  bad({ name: "../evil", command: "x" }, /name must be/);
  bad({ name: "a b", command: "x" }, /name must be/);
  bad({ name: "x".repeat(65), command: "x" }, /name must be/);
  bad({ name: "ok", command: "npx -y pkg" }, /just the program/);
  bad({ name: "ok", command: "-rf" }, /just the program/);
  bad({ name: "ok", command: "a\nb" }, /plain text/);
  bad({ name: "ok", command: "x", args: ["a\u0000b"] }, /plain text/);
  bad({ name: "ok", command: "x", args: [1] }, /plain text/);
  bad({ name: "ok", command: "x", env: { "bad key": "v" } }, /valid variable name/);
  bad({ name: "ok", command: "x", env: { KEY: "line\nbreak" } }, /plain text/);
  bad({ name: "ok", command: "x", env: { KEY: "\ud800" } }, /plain text/);
  bad({ name: "ok", url: "ftp://example.com" }, /http:\/\/ or https:\/\//);
  bad({ name: "ok", url: "javascript:alert(1)", type: "http" }, /http:\/\/ or https:\/\//);
  bad({ name: "ok", url: "not a url", type: "http" }, /not a valid URL/);
  bad({ name: "ok", url: "https://user:pw@example.com/", type: "http" }, /credentials/);
  bad({ name: "ok", type: "sse", url: "https://e.com/sse" }, /SSE/);
  bad({ name: "ok", type: "http", url: "https://e.com", command: "x" }, /not command/);
  bad({ name: "ok", command: "x", headers: { A: "b" } }, /not url or headers/);
  bad({ name: "ok", type: "http", url: "https://e.com", headers: { "bad header": "b" } }, /valid header name/);
  bad("{not json", /valid JSON/);
  bad([], /JSON object/);
  bad({ command: "x" }, /name must be/);
});

test("review text shows the exact command or URL and never env or header values", () => {
  const spec = normalizeMcpInput(stdio({ env: { TOKEN: "super-secret" } }));
  assert.equal(describeMcp(spec), 'npx -y @scope/pkg --dir "/data dir"');
  assert.ok(!describeMcp(spec).includes("super-secret"));
  assert.equal(describeMcp(normalizeMcpInput({ name: "h", url: "https://e.com/mcp", type: "http" })), "https://e.com/mcp");
});

const claudeFile = JSON.stringify({ numStartups: 7, projects: { "/a": { allowedTools: [] } }, theme: "dark", mcpServers: { context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] } } }, null, 2) + "\n";

test("Claude JSON: add merges into an existing config and keeps every other key", () => {
  const spec = normalizeMcpInput(stdio({ env: { TOKEN: "t" } }));
  const next = JSON.parse(addToJsonConfig(claudeFile, spec, "config"));
  const before = JSON.parse(claudeFile);
  assert.deepEqual({ ...next, mcpServers: undefined }, { ...before, mcpServers: undefined });
  assert.deepEqual(next.mcpServers.context7, before.mcpServers.context7);
  assert.deepEqual(next.mcpServers.files, { type: "stdio", command: "npx", args: ["-y", "@scope/pkg", "--dir", "/data dir"], env: { TOKEN: "t" } });
  assert.deepEqual(Object.keys(next), Object.keys(before));
  assert.ok(addToJsonConfig(claudeFile, spec, "config").endsWith("\n"));
});

test("Claude JSON: creates the file or the mcpServers key when missing, with the HTTP shape", () => {
  const spec = normalizeMcpInput({ name: "web", type: "http", url: "https://e.com/mcp", headers: { "X-Key": "k" } });
  assert.deepEqual(JSON.parse(addToJsonConfig(null, spec, "c")), { mcpServers: { web: { type: "http", url: "https://e.com/mcp", headers: { "X-Key": "k" } } } });
  assert.deepEqual(JSON.parse(addToJsonConfig('{"a":1}', spec, "c")).a, 1);
});

test("Claude JSON: duplicate names conflict, case-insensitively, and change nothing", () => {
  for (const name of ["context7", "Context7"]) {
    assert.throws(() => addToJsonConfig(claudeFile, normalizeMcpInput(stdio({ name })), "c"), (e) => e.status === 409 && e.code === "mcp_exists");
  }
});

test("Claude JSON: malformed existing config is refused without leaking its content", () => {
  for (const raw of ['{"mcpServers": ', "[1,2]", '{"mcpServers": []}', '{"mcpServers": "x"}', "null"]) {
    assert.throws(() => addToJsonConfig(raw, normalizeMcpInput(stdio()), "The Claude config"), (e) => e.status === 400 && e.code === "mcp_config_malformed" && !e.message.includes("mcpServers\": "));
  }
  assert.throws(() => addToJsonConfig("x".repeat(300 * 1024), normalizeMcpInput(stdio()), "c"), (e) => e.code === "mcp_config_too_large");
});

test("Claude JSON: remove deletes only the named entry", () => {
  const withTwo = addToJsonConfig(claudeFile, normalizeMcpInput(stdio()), "c");
  const next = JSON.parse(removeFromJsonConfig(withTwo, "files", "c"));
  assert.deepEqual(next, JSON.parse(claudeFile));
  assert.equal(removeFromJsonConfig(claudeFile, "missing", "c"), null);
  assert.equal(removeFromJsonConfig(null, "files", "c"), null);
  assert.equal(removeFromJsonConfig('{"a":1}', "files", "c"), null);
  assert.throws(() => removeFromJsonConfig("{oops", "files", "c"), (e) => e.code === "mcp_config_malformed");
});

test("Claude JSON: keeps tab indentation and a missing trailing newline", () => {
  const raw = '{\n\t"a": 1\n}';
  const out = addToJsonConfig(raw, normalizeMcpInput(stdio()), "c");
  assert.ok(out.includes('\n\t"a": 1'));
  assert.ok(!out.endsWith("\n"));
});

const codexFile = `# my Codex settings
model = "gpt-5"  # keep me
approval_policy = "on-request"

[projects."/home/u/repo"]
trust_level = "trusted"

# context7 docs
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;

test("Codex TOML: add appends a section and leaves comments, settings and other servers byte-for-byte", () => {
  const spec = normalizeMcpInput(stdio({ env: { TOKEN: 'a "quoted" \\ value' } }));
  const next = addToTomlConfig(codexFile, spec, "c");
  assert.ok(next.startsWith(codexFile));
  const parsed = parseToml(next);
  assert.deepEqual(plain(parsed.mcp_servers.files), { command: "npx", args: ["-y", "@scope/pkg", "--dir", "/data dir"], env: { TOKEN: 'a "quoted" \\ value' } });
  assert.deepEqual(plain(parsed.mcp_servers.context7), plain(parseToml(codexFile).mcp_servers.context7));
  assert.equal(parsed.model, "gpt-5");
  assert.deepEqual(plain(parsed.projects), plain(parseToml(codexFile).projects));
});

test("Codex TOML: HTTP shape uses url and http_headers; new file works; file without trailing newline works", () => {
  const spec = normalizeMcpInput({ name: "web", type: "http", url: "https://e.com/mcp", headers: { "X-Api-Key": "k" } });
  assert.deepEqual(plain(parseToml(addToTomlConfig(null, spec, "c"))), { mcp_servers: { web: { url: "https://e.com/mcp", http_headers: { "X-Api-Key": "k" } } } });
  assert.equal(parseToml(addToTomlConfig('model = "x"', spec, "c")).model, "x");
});

test("Codex TOML: duplicates conflict, malformed or unsupported layouts are refused unchanged", () => {
  assert.throws(() => addToTomlConfig(codexFile, normalizeMcpInput(stdio({ name: "CONTEXT7" })), "c"), (e) => e.status === 409);
  assert.throws(() => addToTomlConfig("model = \n[broken", normalizeMcpInput(stdio()), "c"), (e) => e.code === "mcp_config_malformed" && !/broken/.test(e.message));
  assert.throws(() => addToTomlConfig("mcp_servers = { a = { command = \"x\" } }\n", normalizeMcpInput(stdio()), "c"), (e) => e.code === "mcp_config_unsupported");
});

test("Codex TOML: remove drops only that server (and its sub-tables), keeping everything else", () => {
  const spec = normalizeMcpInput(stdio({ env: { TOKEN: "t" } }));
  const added = addToTomlConfig(codexFile, spec, "c");
  const middle = added.replace("# context7 docs", "[mcp_servers.other]\ncommand = \"o\"\n\n# context7 docs");
  const removed = removeFromTomlConfig(middle, "files", "c");
  const parsed = parseToml(removed);
  assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ["context7", "other"]);
  assert.equal(parsed.model, "gpt-5");
  assert.ok(removed.includes("# my Codex settings") && removed.includes("# keep me") && removed.includes("# context7 docs"));
  assert.ok(!removed.includes("files") && !removed.includes("TOKEN"));
  assert.equal(removeFromTomlConfig(codexFile, "files", "c"), null);
  assert.equal(removeFromTomlConfig(null, "files", "c"), null);
  // round trip: add then remove returns the same document
  assert.deepEqual(plain(parseToml(removeFromTomlConfig(added, "files", "c"))), plain(parseToml(codexFile)));
});

test("Codex TOML: a server written in a form the line editor cannot remove is refused, not half-removed", () => {
  const dotted = "[mcp_servers]\nfiles.command = \"x\"\nother.command = \"y\"\n";
  assert.throws(() => removeFromTomlConfig(dotted, "files", "c"), (e) => e.code === "mcp_config_unsupported");
});

test("Codex TOML: quoted server names are removed too", () => {
  const raw = '[mcp_servers."my.server"]\ncommand = "x"\n\n[mcp_servers.keep]\ncommand = "y"\n';
  assert.deepEqual(Object.keys(parseToml(removeFromTomlConfig(raw, "my.server", "c")).mcp_servers), ["keep"]);
});

test("global Codex servers are copied into a session config without touching its other settings", () => {
  const global = `model = "global-model"\n\n[mcp_servers.context7]\ncommand = "npx"\n\n[mcp_servers.files]\ncommand = "npx"\nargs = ["-y", "p"]\n\n[mcp_servers.files.env]\nTOKEN = "t"\n`;
  const session = `[mcp_servers.context7]\ncommand = "session-copy"\n`;
  const merged = mergeGlobalCodexMcp(global, session);
  const parsed = parseToml(merged);
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.mcp_servers.context7.command, "session-copy");
  assert.deepEqual(plain(parsed.mcp_servers.files), { command: "npx", args: ["-y", "p"], env: { TOKEN: "t" } });
  assert.equal(mergeGlobalCodexMcp(global, merged), null);
  assert.deepEqual(plain(parseToml(mergeGlobalCodexMcp(global, null)).mcp_servers.files.env), { TOKEN: "t" });
  assert.equal(mergeGlobalCodexMcp("model = 1", session), null);
  assert.equal(mergeGlobalCodexMcp("broken [", session), null);
  assert.equal(mergeGlobalCodexMcp(global, "broken ["), null);
});
