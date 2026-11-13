import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEC_DEFAULT_ID, buildClaudeManagedSettings, promoteUserPlugins, remoteOf } from "../src/claudeManagedPlugins.ts";

const BASE = { permissions: { deny: ["Agent", "Task"] }, hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "node /usr/local/bin/floq-block-native-subagent.mjs" }] }] } };
const ID = "fast-jev-compaction@fast-jev-compaction";
const GH = { source: { source: "github", repo: "tamaratran/fast-jev-compaction" }, installLocation: "/home/agent/.claude/plugins/marketplaces/fast-jev-compaction" };

/** Fake git: a "clone" writes a marketplace listing the plugin by a relative path. */
function fakeGit(manifest = { name: "fast-jev-compaction", plugins: [{ name: "fast-jev-compaction", source: "./" }] }) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === "clone") {
      const path = args.at(-1)!;
      mkdirSync(join(path, ".git"), { recursive: true });
      mkdirSync(join(path, ".claude-plugin"), { recursive: true });
      writeFileSync(join(path, ".claude-plugin/marketplace.json"), JSON.stringify(manifest));
    }
  };
  return { git, calls };
}

function home(t: { after: (fn: () => void) => void }, settings: unknown, known: unknown) {
  const root = mkdtempSync(join(tmpdir(), "floq-userplugins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = join(root, "home");
  mkdirSync(join(h, ".claude/plugins"), { recursive: true });
  writeFileSync(join(h, ".claude/settings.json"), JSON.stringify(settings));
  writeFileSync(join(h, ".claude/plugins/known_marketplaces.json"), JSON.stringify(known));
  return { home: h, managedDir: join(root, "meta/20000.claude-code") };
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("remoteOf: GitHub and https git sources only", () => {
  assert.deepEqual(remoteOf(GH), { url: "https://github.com/tamaratran/fast-jev-compaction.git" });
  assert.deepEqual(remoteOf({ source: { source: "git", url: "https://h/x.git", ref: "v1" } }), { url: "https://h/x.git", ref: "v1" });
  for (const bad of [undefined, {}, { source: { source: "git", url: "http://h/x.git" } }, { source: { source: "github", repo: "../x" } }, { source: { source: "url", url: "https://h/m.json" } }]) assert.equal(remoteOf(bad), null);
});

test("no enabled plugins: the user's managed settings are just the base policy", () => {
  assert.equal(buildClaudeManagedSettings(BASE, []), BASE);
});

test("an enabled plugin becomes managed, from a local snapshot, ahead of sec-default; base policy kept; user registration repointed", (t) => {
  const paths = home(t, { theme: "dark", enabledPlugins: { [ID]: true, "off@x": false } }, { "fast-jev-compaction": GH });
  const { git, calls } = fakeGit();
  const promoted = promoteUserPlugins({ ...paths, base: BASE, git });
  assert.deepEqual(promoted.map((p) => p.id), [ID]);
  assert.equal(calls[0][0], "clone");
  assert.equal(calls[0].at(-2), "https://github.com/tamaratran/fast-jev-compaction.git");

  const managed = read(join(paths.managedDir, "managed-settings.json"));
  assert.deepEqual(managed.permissions, BASE.permissions, "Floq's deny policy stays");
  assert.deepEqual(managed.hooks, BASE.hooks);
  assert.deepEqual(managed.enabledPlugins, { [ID]: true });
  assert.deepEqual(managed.extraKnownMarketplaces, { "fast-jev-compaction": { source: { source: "directory", path: "/etc/claude-code/plugins/fast-jev-compaction" } } });
  assert.deepEqual(managed.prependPlugins, [ID, SEC_DEFAULT_ID]);

  const known = read(join(paths.home, ".claude/plugins/known_marketplaces.json"));
  assert.deepEqual(known["fast-jev-compaction"].source, { source: "directory", path: "/etc/claude-code/plugins/fast-jev-compaction" });
  assert.equal(read(join(paths.home, ".claude/settings.json")).theme, "dark", "other user settings untouched");
});

test("later starts: refreshed from the remembered origin at most hourly; a failed refresh keeps the snapshot", (t) => {
  const paths = home(t, { enabledPlugins: { [ID]: true } }, { "fast-jev-compaction": GH });
  let clock = 1_800_000_000_000;
  const first = fakeGit();
  promoteUserPlugins({ ...paths, base: BASE, git: first.git, now: () => clock });
  const again = fakeGit();
  assert.equal(promoteUserPlugins({ ...paths, base: BASE, git: again.git, now: () => clock + 60_000 }).length, 1);
  assert.equal(again.calls.length, 0, "fresh snapshot: no git");
  clock += 2 * 60 * 60_000;
  const refresh = fakeGit();
  promoteUserPlugins({ ...paths, base: BASE, git: refresh.git, now: () => clock });
  assert.deepEqual(refresh.calls.map((c) => c[2]), ["fetch", "reset", "clean"], "refreshed from the origin recorded on first promotion");
  assert.equal(refresh.calls[0].includes("origin"), true);
  clock += 2 * 60 * 60_000;
  const down = () => { throw new Error("offline"); };
  assert.equal(promoteUserPlugins({ ...paths, base: BASE, git: down, now: () => clock }).length, 1, "offline: snapshot still used");
});

test("disabled plugins, missing marketplaces, unlisted or non-relative plugins stay normal user plugins", (t) => {
  const paths = home(t, { enabledPlugins: { [ID]: true, "ghost@nowhere": true, "remote@m2": true } }, {
    "fast-jev-compaction": GH,
    m2: { source: { source: "github", repo: "o/m2" } },
  });
  const git = (args: string[]) => {
    const path = args.at(-1)!;
    mkdirSync(join(path, ".git"), { recursive: true }); mkdirSync(join(path, ".claude-plugin"), { recursive: true });
    const name = path.endsWith("m2") ? "m2" : "fast-jev-compaction";
    writeFileSync(join(path, ".claude-plugin/marketplace.json"), JSON.stringify({ name, plugins: [{ name: name === "m2" ? "remote" : "fast-jev-compaction", source: name === "m2" ? { source: "github", repo: "x/y" } : "./" }] }));
  };
  assert.deepEqual(promoteUserPlugins({ ...paths, base: BASE, git }).map((p) => p.id), [ID]);
  assert.deepEqual(read(join(paths.managedDir, "managed-settings.json")).prependPlugins, [ID, SEC_DEFAULT_ID]);
  // Disabling it in the user's settings drops it from managed at the next start.
  writeFileSync(join(paths.home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { [ID]: false } }));
  assert.deepEqual(promoteUserPlugins({ ...paths, base: BASE, git }), []);
  assert.deepEqual(read(join(paths.managedDir, "managed-settings.json")), BASE);
});

test("claude.ai connectors: off writes disableClaudeAiConnectors, on or unset omits it, base keys stay", () => {
  const off = buildClaudeManagedSettings(BASE, [], { claudeAiConnectors: false });
  assert.equal(off.disableClaudeAiConnectors, true);
  assert.deepEqual(off.permissions, BASE.permissions);
  assert.ok(!("disableClaudeAiConnectors" in buildClaudeManagedSettings(BASE, [])));
  assert.ok(!("disableClaudeAiConnectors" in buildClaudeManagedSettings(BASE, [], { claudeAiConnectors: true })));
  assert.ok(!("disableClaudeAiConnectors" in BASE), "the base is not mutated");
  const withPlugin = buildClaudeManagedSettings(BASE, [{ id: ID, marketplace: "m", path: "/p" }], { claudeAiConnectors: false });
  assert.equal(withPlugin.disableClaudeAiConnectors, true);
  assert.deepEqual(withPlugin.prependPlugins, [ID, SEC_DEFAULT_ID]);
});

test("promoteUserPlugins writes the connectors key into the managed file only when off", (t) => {
  const h = home(t, {}, {});
  promoteUserPlugins({ ...h, base: BASE, claudeAiConnectors: false });
  assert.equal(read(join(h.managedDir, "managed-settings.json")).disableClaudeAiConnectors, true);
  promoteUserPlugins({ ...h, base: BASE });
  assert.ok(!("disableClaudeAiConnectors" in read(join(h.managedDir, "managed-settings.json"))));
});
