import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSkillSources, parseCodexMcpToml, parseSkillMetadata, scanSkills, SkillsService } from "../dist/skills.js";

test("parses quoted and folded frontmatter descriptions; rejects malformed metadata", () => {
  assert.deepEqual(parseSkillMetadata("---\nname: docs\ndescription: >\n  Helps with docs\n  and examples\n---\nbody"), { name: "docs", description: "Helps with docs and examples" });
  assert.deepEqual(parseSkillMetadata('---\nname: \'author\'\'s helper\'\ndescription: "A \\"quoted\\" tool"\n---'), { name: "author's helper", description: 'A "quoted" tool' });
  assert.equal(parseSkillMetadata("no frontmatter"), null);
  assert.equal(parseSkillMetadata("---\ndescription: missing name\n---"), null);
  assert.equal(parseSkillMetadata('---\nname: {"unexpected":true}\n---'), null);
  assert.equal(parseSkillMetadata('---\nname: "unterminated\n---'), null);
});

test("rejects skill directory symlinks escaping the user's skills root", () => {
  const temp = mkdtempSync(join(tmpdir(), "floq-skills-"));
  const root = join(temp, "skills");
  const outside = join(temp, "outside");
  mkdirSync(root); mkdirSync(outside);
  mkdirSync(join(outside, "secret"));
  writeFileSync(join(outside, "secret", "SKILL.md"), "---\nname: private\n---\n");
  symlinkSync(join(outside, "secret"), join(root, "linked"), "junction");
  try { assert.deepEqual(scanSkills(root, temp, "home", "claude", ".claude/skills"), []); }
  finally { rmSync(temp, { recursive: true, force: true }); }
});

test("rejects a symlinked provider ancestor escaping the user's mount", () => {
  const temp = mkdtempSync(join(tmpdir(), "floq-skills-"));
  const home = join(temp, "home");
  const outside = join(temp, "outside");
  mkdirSync(home); mkdirSync(outside); mkdirSync(join(outside, "skills")); mkdirSync(join(outside, "skills", "secret"));
  writeFileSync(join(outside, "skills", "secret", "SKILL.md"), "---\nname: private\n---\n");
  symlinkSync(outside, join(home, ".claude"), "junction");
  try { assert.deepEqual(scanSkills(join(home, ".claude", "skills"), home, "home", "claude", ".claude/skills"), []); }
  finally { rmSync(temp, { recursive: true, force: true }); }
});

test("rejects a nested SKILL.md symlink escaping the skills directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "floq-skills-"));
  const root = join(temp, "skills");
  const outside = join(temp, "outside.md");
  mkdirSync(root); mkdirSync(join(root, "linked"));
  writeFileSync(outside, "---\nname: private\n---\n");
  symlinkSync(outside, join(root, "linked", "SKILL.md"), "file");
  try { assert.deepEqual(scanSkills(root, temp, "home", "claude", ".claude/skills"), []); }
  finally { rmSync(temp, { recursive: true, force: true }); }
});

test("home skill shadows bundled skill with same provider and name", () => {
  const merged = mergeSkillSources(
    [{ name: "Floq", description: "Bundled", source: "bundled", provider: "codex", location: ".codex/skills/floq" }],
    [{ name: "floq", description: "Personal edit", source: "home", provider: "codex", location: ".floq/codex/session/skills/floq" }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].description, "Personal edit");
  assert.equal(merged[0].source, "home");
});

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "floq-project-skills-"));
  const home = join(temp, "home");
  const project = join(home, ".floq", "projects", "project-1");
  const bundle = join(temp, "bundle");
  mkdirSync(project, { recursive: true });
  mkdirSync(bundle, { recursive: true });
  const handle = { mountPath: home, uid: typeof process.getuid === "function" ? process.getuid() : 0 };
  const invocations = [];
  const driver = {
    name: "local",
    hostPath: (h, path) => join(h.mountPath, path),
    homePath: (h) => h.mountPath,
    spawn: (h, spec) => {
      invocations.push(spec);
      const child = spawnChild(spec.file, spec.args, { cwd: join(h.mountPath, spec.cwd), env: spec.env, windowsHide: true });
      const dataListeners = new Set();
      const exitListeners = new Set();
      child.stdout.on("data", (chunk) => { for (const listener of dataListeners) listener(chunk.toString()); });
      child.stderr.on("data", (chunk) => { for (const listener of dataListeners) listener(chunk.toString()); });
      child.on("close", (exitCode) => { for (const listener of exitListeners) listener({ exitCode: exitCode ?? 1 }); });
      return {
        onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
        onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
        kill(signal) { child.kill(signal); },
      };
    },
  };
  const shards = { awakeHandle: () => undefined, driver };
  const pool = { query: async (_sql, params) => params[1] === "owner" && params[0] === "project-1" ? { rows: [{ cwd: ".floq/projects/project-1" }] } : { rows: [] } };
  const withShardActivity = async (_user, operation) => operation(handle);
  const service = new SkillsService({ skelDir: bundle, preinstallSkills: true }, shards, pool, withShardActivity);
  return { temp, home, project, bundle, handle, shards, service, invocations };
}

test("creates native-discoverable skills only in the owned canonical project checkout", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  const claude = await f.service.addProjectSkill("owner", "project-1", {
    provider: "claude", name: "release-notes", description: "Write release notes", instructions: "Summarize the changes.",
  });
  const codex = await f.service.addProjectSkill("owner", "project-1", {
    provider: "codex", name: "review-pr", description: "Review a PR", instructions: "Inspect the diff.",
  });
  assert.equal(claude.skill.location, ".claude/skills/release-notes");
  assert.equal(codex.skill.location, ".agents/skills/review-pr");
  assert.ok(existsSync(join(f.project, ".claude", "skills", "release-notes", "SKILL.md")));
  assert.ok(existsSync(join(f.project, ".agents", "skills", "review-pr", "SKILL.md")));
  assert.equal(f.invocations.length, 2);
  assert.ok(f.invocations.every((spec) => spec.file === process.execPath && spec.args[0] === "-e" && spec.cwd === ".floq/projects/project-1"));
  assert.ok(f.invocations.every((spec) => !("ANTHROPIC_API_KEY" in spec.env) && !("OPENAI_API_KEY" in spec.env)));
  const listed = await f.service.listProject("owner", "project-1");
  assert.deepEqual(listed.skills.map((skill) => [skill.name, skill.provider, skill.scope]), [
    ["release-notes", "claude", "project"], ["review-pr", "codex", "project"],
  ]);
  const manifest = readFileSync(join(f.project, ".claude", "skills", "release-notes", "SKILL.md"), "utf8");
  assert.deepEqual(parseSkillMetadata(manifest), { name: "release-notes", description: "Write release notes" });
  await assert.rejects(f.service.addProjectSkill("owner", "project-1", { provider: "claude", name: "release-notes", description: "duplicate", instructions: "No overwrite" }), /already exists/);
  await assert.rejects(f.service.addProjectSkill("stranger", "project-1", { provider: "claude", name: "stolen", description: "No", instructions: "No" }), /Project not found/);
  await assert.rejects(f.service.addProjectSkill("owner", "project-1", { provider: "claude", name: "../escape", description: "No", instructions: "No" }), /lowercase skill slug/);
});

test("project skill package installs nested text files create-only through the user shard driver", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  const packageFiles = {
    "SKILL.md": "---\nname: imported-helper\ndescription: Imported package\n---\n\nUse the helper.\n",
    "scripts/check.sh": "#!/bin/sh\necho ok\n",
    "references/guide.md": "Reference material.\n",
  };
  const result = await f.service.addProjectSkillPackage("owner", "project-1", { provider: "codex", files: packageFiles });
  assert.equal(result.skill.name, "imported-helper");
  assert.equal(result.skill.location, ".agents/skills/imported-helper");
  assert.equal(readFileSync(join(f.project, ".agents", "skills", "imported-helper", "scripts", "check.sh"), "utf8"), packageFiles["scripts/check.sh"]);
  assert.equal(readFileSync(join(f.project, ".agents", "skills", "imported-helper", "references", "guide.md"), "utf8"), packageFiles["references/guide.md"]);
  assert.equal(f.invocations.at(-1).file, process.execPath);
  await assert.rejects(f.service.addProjectSkillPackage("owner", "project-1", { provider: "codex", files: packageFiles }), /already exists/);
  await assert.rejects(f.service.addProjectSkillPackage("owner", "project-1", {
    provider: "codex",
    files: { "SKILL.md": packageFiles["SKILL.md"], "../outside.md": "Must not escape." },
  }), { code: "invalid_skill_package" });
  assert.equal(existsSync(join(f.project, ".agents", "outside.md")), false);
});

test("project skill writer refuses provider-directory symlinks", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  const outside = join(f.temp, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.project, ".claude"), "junction");
  await assert.rejects(f.service.addProjectSkill("owner", "project-1", {
    provider: "claude", name: "safe-name", description: "No path traversal", instructions: "Must not write outside.",
  }), /unsafe entry/);
  assert.equal(existsSync(join(outside, "skills", "safe-name", "SKILL.md")), false);
});

test("project MCP inventory redacts credentials, args, and environment values", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  writeFileSync(join(f.project, ".mcp.json"), JSON.stringify({ mcpServers: {
    local: { command: "C:\\tools\\bridge.exe", args: ["--token", "secret-arg"], env: { TOKEN: "secret-env" } },
    remote: { type: "http", url: "https://alice:secret@example.test/private/path?token=secret#frag" },
  } }));
  mkdirSync(join(f.project, ".codex"));
  writeFileSync(join(f.project, ".codex", "config.toml"), `[mcp_servers."codex-tools"]\ncommand = "node"\nargs = ["--token", "codex-secret"]\n[mcp_servers.cloud]\ntype = "http"\nurl = "https://bob:secret@codex.example/path?key=private"\n`);
  const result = await f.service.listMcp("owner", "project", "project-1");
  assert.deepEqual(result.servers.map((server) => [server.name, server.provider, server.transport]), [
    ["local", "claude", "stdio"], ["remote", "claude", "http"], ["cloud", "codex", "http"], ["codex-tools", "codex", "stdio"],
  ]);
  const remote = result.servers.find((server) => server.name === "remote");
  assert.equal(remote.urlHost, "example.test");
  assert.equal(remote.command, undefined);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.malformedConfigs, 0);
  writeFileSync(join(f.project, ".mcp.json"), "not valid json with key secret-should-not-leak");
  const malformed = await f.service.listMcp("owner", "project", "project-1");
  assert.equal(malformed.malformedConfigs, 1);
  assert.equal(JSON.stringify(malformed).includes("secret-should-not-leak"), false);
});

test("global inventories remain readable while home is locked and mark whether it was scanned", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  mkdirSync(join(f.bundle, ".claude", "skills", "bundled-helper"), { recursive: true });
  writeFileSync(join(f.bundle, ".claude", "skills", "bundled-helper", "SKILL.md"), "---\nname: bundled-helper\ndescription: Bundled\n---\n");
  writeFileSync(join(f.bundle, ".claude.json"), JSON.stringify({ mcpServers: { bundled: { type: "http", url: "https://bundle.example/path" } } }));
  const skillList = await f.service.list("owner");
  assert.equal(skillList.homeScanned, false);
  assert.equal(skillList.skills[0].scope, "global");
  const mcp = await f.service.listMcp("owner", "global");
  assert.equal(mcp.homeScanned, false);
  assert.equal(mcp.servers[0].name, "bundled");
});

test("Codex MCP TOML parser hides syntax errors and parses quoted keys", () => {
  assert.deepEqual(parseCodexMcpToml("[mcp_servers.\"safe name\"]\ncommand=\"node\"\nargs=[\"private\"]", "project", "project").servers.map((server) => server.name), ["safe name"]);
  const malformed = parseCodexMcpToml("[mcp_servers.x]\ncommand = [broken\nAPI_TOKEN=\"secret\"", "project", "project");
  assert.equal(malformed.malformed, true);
  assert.equal(JSON.stringify(malformed).includes("secret"), false);
});

test("MCP inventory ignores symlinked config files without reading their contents", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  const outside = join(f.temp, "outside-mcp.json");
  writeFileSync(outside, JSON.stringify({ mcpServers: { private: { command: "secret-command" } } }));
  symlinkSync(outside, join(f.project, ".mcp.json"), "file");
  const result = await f.service.listMcp("owner", "project", "project-1");
  assert.deepEqual(result.servers, []);
  assert.equal(JSON.stringify(result).includes("secret-command"), false);
});

function seedProjectSkill(f, files) {
  const dir = join(f.project, ".claude", "skills", "demo");
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n<script>alert(1)</script>\n");
  writeFileSync(join(dir, "refs", "notes.md"), "notes");
  for (const [name, data] of Object.entries(files ?? {})) writeFileSync(join(dir, name), data);
  return dir;
}
const projectInput = (extra = {}) => ({ scope: "project", projectId: "project-1", provider: "claude", location: ".claude/skills/demo", ...extra });

test("skill reader lists and reads text files of an owned project skill", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  seedProjectSkill(f);
  const list = await f.service.readSkillFiles("owner", projectInput());
  assert.deepEqual(list.files.map((file) => file.path), ["refs/notes.md", "SKILL.md"]);
  const file = await f.service.readSkillFiles("owner", projectInput({ path: "SKILL.md" }));
  assert.match(file.content, /<script>alert\(1\)<\/script>/);
});

test("skill reader rejects path traversal and unknown locations", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  seedProjectSkill(f);
  writeFileSync(join(f.project, "secret.txt"), "top secret");
  for (const path of ["../../../secret.txt", "refs/../../../secret.txt", "/etc/passwd", "..\secret.txt", "refs//notes.md", "C:/x"]) {
    await assert.rejects(f.service.readSkillFiles("owner", projectInput({ path })), /Unsafe skill file path|unavailable/);
  }
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ location: ".claude/skills/../../secret.txt" })), /Unsafe|not found/i);
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ location: ".claude/skills/missing" })), /Skill not found/);
});

test("skill reader refuses a symlink that escapes the skill folder", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  const dir = seedProjectSkill(f);
  writeFileSync(join(f.temp, "outside.txt"), "outside secret");
  mkdirSync(join(f.temp, "outside-dir"));
  writeFileSync(join(f.temp, "outside-dir", "x.txt"), "outside secret");
  try {
    symlinkSync(join(f.temp, "outside.txt"), join(dir, "link.txt"), "file");
    symlinkSync(join(f.temp, "outside-dir"), join(dir, "linkdir"), "junction");
  } catch (error) { t.skip(`symlinks unavailable: ${error.code}`); return; }
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ path: "link.txt" })), /unavailable/);
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ path: "linkdir/x.txt" })), /unavailable/);
  const list = await f.service.readSkillFiles("owner", projectInput());
  assert.deepEqual(list.files.map((file) => file.path), ["refs/notes.md", "SKILL.md"]);
});

test("skill reader hides another owner's project skills", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  seedProjectSkill(f);
  await assert.rejects(f.service.readSkillFiles("stranger", projectInput()), /Project not found/);
  await assert.rejects(f.service.readSkillFiles("stranger", projectInput({ path: "SKILL.md" })), /Project not found/);
});

test("skill reader refuses oversized and binary files", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  seedProjectSkill(f, { "big.txt": "a".repeat(256 * 1024 + 1), "bin.dat": Buffer.from([1, 2, 0, 3]), "bad.txt": Buffer.from([0xff, 0xfe, 0xfd]) });
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ path: "big.txt" })), (error) => error.status === 413 && error.code === "file_too_large");
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ path: "bin.dat" })), (error) => error.status === 415);
  await assert.rejects(f.service.readSkillFiles("owner", projectInput({ path: "bad.txt" })), (error) => error.status === 415);
  const list = await f.service.readSkillFiles("owner", projectInput());
  assert.equal(list.files.find((file) => file.path === "big.txt").size, 256 * 1024 + 1);
});

test("skill reader serves bundled and home global skills only when discovered", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  mkdirSync(join(f.bundle, ".claude", "skills", "b"), { recursive: true });
  writeFileSync(join(f.bundle, ".claude", "skills", "b", "SKILL.md"), "---\nname: b\ndescription: Bundled\n---\nhi");
  mkdirSync(join(f.home, ".claude", "skills", "h"), { recursive: true });
  writeFileSync(join(f.home, ".claude", "skills", "h", "SKILL.md"), "---\nname: h\ndescription: Home\n---\nyo");
  writeFileSync(join(f.home, "vault.json"), "{}");
  const g = (extra) => ({ scope: "global", provider: "claude", ...extra });
  const bundled = await f.service.readSkillFiles("owner", g({ source: "bundled", location: ".claude/skills/b", path: "SKILL.md" }));
  assert.match(bundled.content, /hi$/);
  // A sleeping home is now mounted for the read instead of reporting "Skill not found".
  assert.ok((await f.service.readSkillFiles("owner", g({ source: "home", location: ".claude/skills/h" }))).files.length);
  f.shards.awakeHandle = () => f.handle;
  const home = await f.service.readSkillFiles("owner", g({ source: "home", location: ".claude/skills/h", path: "SKILL.md" }));
  assert.match(home.content, /yo$/);
  await assert.rejects(f.service.readSkillFiles("owner", g({ source: "home", location: ".." , path: "vault.json" })), /Unsafe|not found/i);
  await assert.rejects(f.service.readSkillFiles("owner", g({ source: "home", location: ".claude/skills/h", path: "../../../vault.json" })), /Unsafe/);
});
