import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEC_DEFAULT_ID, buildClaudeManagedSettings, cloneMarketplace, parseTrustedPlugins, reconcileUserMarketplaces, syncClaudeManagedSettings, activeManagedMarketplaces, type LocalMarketplace,
} from "../src/claudeManagedPlugins.ts";

const BASE = { permissions: { deny: ["Agent", "Task"] }, hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: "node /usr/local/bin/floq-block-native-subagent.mjs" }] }] } };
const FJ = "fast-jev-compaction@fast-jev-compaction=tamaratran/fast-jev-compaction";

/** A fake `git` that "clones" by writing a marketplace.json (name/plugin configurable). */
function fakeGit(manifest: (path: string) => unknown) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === "clone") {
      const path = args.at(-1)!;
      mkdirSync(join(path, ".git"), { recursive: true });
      mkdirSync(join(path, ".claude-plugin"), { recursive: true });
      writeFileSync(join(path, ".claude-plugin/marketplace.json"), JSON.stringify(manifest(path)));
    }
  };
  return { git, calls };
}
const goodManifest = () => ({ name: "fast-jev-compaction", plugins: [{ name: "fast-jev-compaction", source: "./" }] });

test("parses plugin@marketplace=source: GitHub shorthand -> https clone URL, https git URL, optional #ref; dedupes", () => {
  assert.deepEqual(parseTrustedPlugins(undefined), []);
  const list = parseTrustedPlugins(`${FJ}#v0.3.0, a@m=https://git.example.com/x/y.git ,${FJ}#v0.3.0`);
  assert.deepEqual(list.map((p) => p.id), ["fast-jev-compaction@fast-jev-compaction", "a@m"]);
  assert.deepEqual(list[0].remote, { url: "https://github.com/tamaratran/fast-jev-compaction.git", ref: "v0.3.0" });
  assert.deepEqual(list[1].remote, { url: "https://git.example.com/x/y.git" });
});

test("rejects malformed entries, missing or non-https sources, built-ins and bad refs", () => {
  for (const bad of ["noat=o/r", "a@b@c=o/r", "a@m", "a@m=", "a@m=not a repo", "x@builtin=o/r", "a@m=http://insecure.example/x.git", "-a@m=o/r", "a@m=o/r#--upload-pack=x", "a@m=o/r#"]) {
    assert.throws(() => parseTrustedPlugins(bad), /FLOQ_CLAUDE_PLUGINS/, bad);
  }
});

test("no trusted plugins: base settings untouched (the security default keeps its own seat)", () => {
  assert.equal(buildClaudeManagedSettings(BASE, []), BASE);
});

test("trusted plugins: enabled, local directory marketplace, seated ahead of sec-default; deny policy kept", () => {
  const [plugin] = parseTrustedPlugins(FJ);
  const out = buildClaudeManagedSettings(BASE, [{ plugin, path: "/usr/local/share/floq/claude-plugins/fast-jev-compaction" }]);
  assert.deepEqual(out.permissions, BASE.permissions);
  assert.deepEqual(out.hooks, BASE.hooks);
  assert.deepEqual(out.enabledPlugins, { "fast-jev-compaction@fast-jev-compaction": true });
  assert.deepEqual(out.extraKnownMarketplaces, { "fast-jev-compaction": { source: { source: "directory", path: "/usr/local/share/floq/claude-plugins/fast-jev-compaction" } } });
  assert.deepEqual(out.prependPlugins, ["fast-jev-compaction@fast-jev-compaction", SEC_DEFAULT_ID]);
});

test("cloneMarketplace: clones once with hooks-free git, refreshes on later starts, and verifies the manifest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "floq-plugins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [plugin] = parseTrustedPlugins(FJ + "#main");
  const { git, calls } = fakeGit(goodManifest);
  assert.equal(cloneMarketplace(plugin, dir, git), join(dir, "fast-jev-compaction"));
  assert.deepEqual(calls[0], ["clone", "--depth", "1", "--branch", "main", "https://github.com/tamaratran/fast-jev-compaction.git", join(dir, "fast-jev-compaction")]);
  cloneMarketplace(plugin, dir, git);
  assert.deepEqual(calls.slice(1).map((c) => c.slice(2, 4)), [["fetch", "--depth"], ["reset", "--hard"], ["clean", "-fdx"]]);
  for (const [label, manifest] of [
    ["wrong name", { name: "other", plugins: [{ name: "fast-jev-compaction", source: "./" }] }],
    ["plugin missing", { name: "fast-jev-compaction", plugins: [] }],
    ["remote source", { name: "fast-jev-compaction", plugins: [{ name: "fast-jev-compaction", source: { source: "github", repo: "x/y" } }] }],
  ] as const) {
    rmSync(join(dir, "fast-jev-compaction"), { recursive: true, force: true });
    assert.throws(() => cloneMarketplace(plugin, dir, fakeGit(() => manifest).git), Error, label);
  }
});

test("sync: clones, writes base + plugins, records the active set; a failing clone or bad value falls back to the base", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "floq-managed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const basePath = join(dir, "base.json");
  const targetPath = join(dir, "etc/claude-code/managed-settings.json");
  const pluginsDir = join(dir, "plugins");
  writeFileSync(basePath, JSON.stringify(BASE));
  assert.deepEqual(syncClaudeManagedSettings({ raw: FJ, basePath, targetPath, pluginsDir, git: fakeGit(goodManifest).git }).map((p) => p.id), ["fast-jev-compaction@fast-jev-compaction"]);
  const written = JSON.parse(readFileSync(targetPath, "utf8"));
  assert.deepEqual(written.prependPlugins, ["fast-jev-compaction@fast-jev-compaction", SEC_DEFAULT_ID]);
  assert.equal(written.extraKnownMarketplaces["fast-jev-compaction"].source.path, join(pluginsDir, "fast-jev-compaction"));
  assert.equal(activeManagedMarketplaces().length, 1);

  const failing = () => { throw new Error("network down"); };
  assert.deepEqual(syncClaudeManagedSettings({ raw: "p@m=o/r", basePath, targetPath, pluginsDir: join(dir, "p2"), git: failing }), []);
  assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), BASE, "clone failed: base policy, no plugins");
  assert.equal(activeManagedMarketplaces().length, 0);
  assert.deepEqual(syncClaudeManagedSettings({ raw: "garbage", basePath, targetPath, pluginsDir }), []);
  assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), BASE);
});

test("reconcile drops a user's conflicting registration of a trusted marketplace, keeps everything else", (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude/plugins"), { recursive: true });
  const github = { source: { source: "github", repo: "tamaratran/fast-jev-compaction" } };
  writeFileSync(join(home, ".claude/plugins/known_marketplaces.json"), JSON.stringify({ "fast-jev-compaction": github, other: github }));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ theme: "dark", extraKnownMarketplaces: { "fast-jev-compaction": github, other: github }, enabledPlugins: { "fast-jev-compaction@fast-jev-compaction": true } }));
  const [plugin] = parseTrustedPlugins(FJ);
  const locals: LocalMarketplace[] = [{ plugin, path: "/usr/local/share/floq/claude-plugins/fast-jev-compaction" }];
  assert.deepEqual(reconcileUserMarketplaces(home, locals), ["fast-jev-compaction"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, ".claude/plugins/known_marketplaces.json"), "utf8"))), ["other"]);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), ["other"]);
  assert.equal(settings.theme, "dark");
  // The managed directory registration itself is not a conflict; nothing to do the second time or without trusted plugins.
  writeFileSync(join(home, ".claude/plugins/known_marketplaces.json"), JSON.stringify({ "fast-jev-compaction": { source: { source: "directory", path: locals[0].path } } }));
  assert.deepEqual(reconcileUserMarketplaces(home, locals), []);
  assert.deepEqual(reconcileUserMarketplaces(home, []), []);
});
