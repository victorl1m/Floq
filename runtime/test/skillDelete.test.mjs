import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsService } from "../dist/skills.js";
import { ShardService } from "../dist/shards.js";

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "floq-skill-delete-"));
  const home = join(temp, "home");
  const bundle = join(temp, "bundle");
  mkdirSync(home, { recursive: true });
  mkdirSync(bundle, { recursive: true });
  const handle = { mountPath: home, uid: typeof process.getuid === "function" ? process.getuid() : 0 };
  const driver = {
    name: "local",
    hostPath: (h, path) => join(h.mountPath, path),
    homePath: (h) => h.mountPath,
    spawn: (h, spec) => {
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
  const removals = [];
  const pool = {
    query: async (sql, params) => {
      if (/FROM skill_removals/.test(sql)) return { rows: removals.filter((r) => r.user_id === params[0]).map((r) => ({ provider: r.provider, name: r.name })) };
      if (/INTO skill_removals/.test(sql)) {
        if (!removals.some((r) => r.user_id === params[0] && r.provider === params[1] && r.name === params[2])) removals.push({ user_id: params[0], provider: params[1], name: params[2] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const shards = { awakeHandle: () => undefined, driver };
  const config = { skelDir: bundle, preinstallSkills: true };
  const service = new SkillsService(config, shards, pool, async (_user, operation) => operation(handle));
  return { temp, home, bundle, handle, driver, removals, shards, config, service };
}

const skillMd = (name) => `---\nname: ${name}\ndescription: d\n---\nbody`;
function addSkill(root, rel, files = {}) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd(rel.split("/").at(-1)));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
const gl = (extra) => ({ scope: "global", provider: "claude", location: ".claude/skills/brainstorming", ...extra });

test("a home skill read while the shard starts asleep wakes it and reads a nested non-Markdown file", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.home, ".claude/skills/h", { "scripts/stop-server.sh": "#!/bin/sh\nexit 0\n" });
  let awake = false;
  let wakes = 0;
  f.shards.awakeHandle = () => (awake ? f.handle : undefined);
  f.service.withShardActivity = async (_u, op) => { wakes++; awake = true; return op(f.handle); };
  const r = await f.service.readSkillFiles("owner", gl({ source: "home", location: ".claude/skills/h", path: "scripts/stop-server.sh" }));
  assert.equal(r.content, "#!/bin/sh\nexit 0\n");
  assert.equal(wakes, 1);
});

test("a skill present in both bundle and home reads correctly whichever source is named, asleep or awake", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.bundle, ".claude/skills/brainstorming", { "scripts/stop-server.sh": "echo bundle\n" });
  addSkill(f.home, ".claude/skills/brainstorming", { "scripts/stop-server.sh": "echo home\n" });
  for (const awake of [false, true]) {
    f.shards.awakeHandle = () => (awake ? f.handle : undefined);
    assert.match((await f.service.readSkillFiles("owner", gl({ source: "home", path: "scripts/stop-server.sh" }))).content, /echo home/);
    assert.match((await f.service.readSkillFiles("owner", gl({ source: "bundled", path: "scripts/stop-server.sh" }))).content, /echo bundle/);
    assert.ok((await f.service.readSkillFiles("owner", gl({ source: "bundled" }))).files.some((x) => x.path === "scripts/stop-server.sh"));
  }
});

test("source fallback happens only when the other source's own scan confirms the location", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.bundle, ".claude/skills/b");
  addSkill(f.home, ".claude/skills/h");
  assert.match((await f.service.readSkillFiles("owner", gl({ source: "home", location: ".claude/skills/b", path: "SKILL.md" }))).content, /body/);
  assert.match((await f.service.readSkillFiles("owner", gl({ source: "bundled", location: ".claude/skills/h", path: "SKILL.md" }))).content, /body/);
  for (const source of ["home", "bundled"]) {
    await assert.rejects(f.service.readSkillFiles("owner", gl({ source, location: ".claude/skills/nope" })), /Skill not found/);
    await assert.rejects(f.service.readSkillFiles("owner", gl({ source, location: ".claude/skills/h", path: "../../x" })), /Unsafe/);
  }
});

test("an unlockable shard gives a precise error, but a confirmed bundled copy is still served", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.bundle, ".claude/skills/brainstorming");
  f.service.withShardActivity = async () => { throw new Error("gocryptfs boom"); };
  assert.match((await f.service.readSkillFiles("owner", gl({ source: "home", path: "SKILL.md" }))).content, /body/);
  await assert.rejects(f.service.readSkillFiles("owner", gl({ source: "home", location: ".claude/skills/h2" })),
    (e) => e.status === 503 && e.code === "shard_unavailable" && !/boom/.test(e.message));
});

test("another user's home is never served", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.home, ".claude/skills/h");
  const other = { mountPath: join(f.temp, "other-home"), uid: f.handle.uid };
  mkdirSync(other.mountPath, { recursive: true });
  f.service.withShardActivity = async (user, op) => op(user === "owner" ? f.handle : other);
  await f.service.readSkillFiles("owner", gl({ source: "home", location: ".claude/skills/h", path: "SKILL.md" }));
  await assert.rejects(f.service.readSkillFiles("stranger", gl({ source: "home", location: ".claude/skills/h", path: "SKILL.md" })), /Skill not found/);
});

test("reads a Codex skill that lives in a per-session CODEX_HOME", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  const location = ".floq/codex/e4fba8b6-9e49-4c0b-b631-4d0bab4e2f4f/skills/diagnosing-superpowers";
  addSkill(f.home, location, { "notes.sh": "echo hi\n" });
  const input = { scope: "global", provider: "codex", source: "home", location };
  assert.ok((await f.service.readSkillFiles("owner", input)).files.some((x) => x.path === "notes.sh"));
  assert.equal((await f.service.readSkillFiles("owner", { ...input, path: "notes.sh" })).content, "echo hi\n");
});

test("deleting a bundled skill removes every home copy, sticks, and leaves the shared bundle alone", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.bundle, ".claude/skills/brainstorming");
  addSkill(f.bundle, ".codex/skills/brainstorming");
  addSkill(f.bundle, ".claude/skills/keeper");
  addSkill(f.home, ".claude/skills/brainstorming");
  addSkill(f.home, ".codex/skills/brainstorming");
  addSkill(f.home, ".floq/codex/s1/skills/brainstorming");
  addSkill(f.home, ".claude/skills/keeper");
  const res = await f.service.deleteSkill("owner", { provider: "codex", location: ".codex/skills/brainstorming" });
  assert.deepEqual(res, { removed: 2, hidden: true });
  assert.ok(!existsSync(join(f.home, ".codex/skills/brainstorming")));
  assert.ok(!existsSync(join(f.home, ".floq/codex/s1/skills/brainstorming")));
  assert.ok(existsSync(join(f.home, ".claude/skills/brainstorming")), "other provider is untouched");
  assert.ok(existsSync(join(f.bundle, ".codex/skills/brainstorming/SKILL.md")), "shared bundle is read-only");
  assert.deepEqual(f.removals.map((r) => `${r.provider}:${r.name}`), ["codex:brainstorming"]);
  f.shards.awakeHandle = () => f.handle;
  const listed = (await f.service.list("owner")).skills.map((x) => `${x.provider}:${x.name}`);
  assert.ok(!listed.includes("codex:brainstorming") && listed.includes("claude:brainstorming") && listed.includes("claude:keeper"));
  await assert.rejects(f.service.readSkillFiles("owner", { scope: "global", provider: "codex", source: "bundled", location: ".codex/skills/brainstorming" }), /Skill not found/);
  assert.deepEqual(await f.service.deleteSkill("owner", { provider: "codex", location: ".codex/skills/brainstorming" }), { removed: 0, hidden: true }); // idempotent
});

test("Floq skills cannot be deleted from any source or location", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  for (const name of ["floq-orchestrate", "floq-vault"]) {
    addSkill(f.bundle, `.claude/skills/${name}`);
    addSkill(f.home, `.claude/skills/${name}`);
    addSkill(f.home, `.floq/codex/s1/skills/${name}`);
    for (const [provider, location] of [["claude", `.claude/skills/${name}`], ["codex", `.floq/codex/s1/skills/${name}`], ["codex", `.codex/skills/${name}`]]) {
      await assert.rejects(f.service.deleteSkill("owner", { provider, location }), (e) => e.status === 403 && e.code === "skill_protected");
    }
    assert.ok(existsSync(join(f.home, `.claude/skills/${name}`)));
  }
  assert.equal(f.removals.length, 0);
});

test("deletion is confined to the caller's own confirmed home and never follows symlinks", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.home, ".claude/skills/mine");
  const other = join(f.temp, "other-home");
  addSkill(other, ".claude/skills/theirs");
  f.service.withShardActivity = async (user, op) => op(user === "owner" ? f.handle : { mountPath: other, uid: f.handle.uid });
  await assert.rejects(f.service.deleteSkill("owner", { provider: "claude", location: ".claude/skills/theirs" }), /Skill not found/);
  assert.ok(existsSync(join(other, ".claude/skills/theirs/SKILL.md")));
  await assert.rejects(f.service.deleteSkill("owner", { provider: "claude", location: ".claude/skills/../../x" }), /Unsafe/);
  await assert.rejects(f.service.deleteSkill("owner", { provider: "claude", location: ".claude/skills/unknown" }), /Skill not found/);
  const secret = join(f.temp, "secret");
  mkdirSync(secret);
  writeFileSync(join(secret, "keep.txt"), "keep");
  try { symlinkSync(secret, join(f.home, ".claude/skills/mine/link"), "dir"); } catch { /* symlinks unavailable on this host */ }
  await f.service.deleteSkill("owner", { provider: "claude", location: ".claude/skills/mine" });
  assert.ok(!existsSync(join(f.home, ".claude/skills/mine")));
  assert.equal(readFileSync(join(secret, "keep.txt"), "utf8"), "keep");
  assert.ok(existsSync(join(other, ".claude/skills/theirs/SKILL.md")));
});

test("seeding honours deletions and PREINSTALL_SKILLS but always keeps settings and Floq skills", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  addSkill(f.bundle, ".claude/skills/brainstorming");
  addSkill(f.bundle, ".claude/skills/gone");
  addSkill(f.bundle, ".claude/skills/floq-vault");
  addSkill(f.bundle, ".codex/skills/brainstorming");
  addSkill(f.bundle, ".codex/skills/floq-orchestrate");
  writeFileSync(join(f.bundle, ".claude.json"), "{}");
  writeFileSync(join(f.bundle, ".codex", "config.toml"), "");
  const dirFor = (name) => { const dir = join(f.temp, name); mkdirSync(dir, { recursive: true }); return dir; };
  const make = (preinstallSkills) => new ShardService({}, { skelDir: f.bundle, preinstallSkills }, f.driver);
  const uid = f.handle.uid;

  const on = dirFor("on");
  make(true).seed(on, ".", uid, new Set(["claude:gone"]));
  assert.ok(existsSync(join(on, ".claude/skills/brainstorming/SKILL.md")) && existsSync(join(on, ".claude/skills/floq-vault/SKILL.md")) && existsSync(join(on, ".codex/skills/brainstorming/SKILL.md")));
  assert.ok(!existsSync(join(on, ".claude/skills/gone")), "a deleted skill is not re-seeded");
  make(true).seed(on, ".", uid, new Set(["claude:gone"]));
  assert.ok(!existsSync(join(on, ".claude/skills/gone")), "still gone after another wake");

  const off = dirFor("off");
  make(false).seed(off, ".", uid, new Set());
  assert.ok(!existsSync(join(off, ".claude/skills/brainstorming")) && !existsSync(join(off, ".codex/skills/brainstorming")) && !existsSync(join(off, ".claude/skills/gone")));
  assert.ok(existsSync(join(off, ".claude/skills/floq-vault/SKILL.md")) && existsSync(join(off, ".codex/skills/floq-orchestrate/SKILL.md")), "Floq skills stay");
  assert.ok(existsSync(join(off, ".claude.json")) && existsSync(join(off, ".codex/config.toml")), "non-skill skeleton stays");

  const unknown = dirFor("unknown");
  make(true).seed(unknown, ".", uid, null);
  assert.ok(!existsSync(join(unknown, ".claude/skills/brainstorming")) && existsSync(join(unknown, ".claude/skills/floq-vault/SKILL.md")));

  const codexHome = dirFor("codex");
  make(true).seed(codexHome, ".codex", uid, new Set(["codex:brainstorming"]));
  assert.ok(!existsSync(join(codexHome, "skills/brainstorming")) && existsSync(join(codexHome, "skills/floq-orchestrate/SKILL.md")));
});

test("PREINSTALL_SKILLS off lists and reads only the Floq skills", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.temp, { recursive: true, force: true }));
  f.config.preinstallSkills = false;
  addSkill(f.bundle, ".claude/skills/brainstorming");
  addSkill(f.bundle, ".claude/skills/floq-vault");
  assert.deepEqual((await f.service.list("owner")).skills.map((x) => x.name), ["floq-vault"]);
  await assert.rejects(f.service.readSkillFiles("owner", gl({ source: "bundled" })), /Skill not found/);
  assert.ok((await f.service.readSkillFiles("owner", gl({ source: "bundled", location: ".claude/skills/floq-vault" }))).files.length);
});
