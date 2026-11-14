import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promoteUserPlugins } from "../src/claudeManagedPlugins.ts";
import { syncCodexManagedGuidance, syncProtectedFloqSkill } from "../src/codexGuidance.ts";
import { removeManagedCheckout } from "../src/projectDelete.ts";
import { copyHomeTree, openHomeDir, ownHomeTree, removeHomeTree, UnsafeHomePathError } from "../src/shard.ts";

const uid = process.getuid!();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "floq-confine-"));
  const home = join(root, "home");
  const victim = join(root, "victim");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(victim, "secret"), { recursive: true });
  writeFileSync(join(victim, "secret", "token.txt"), "victim-secret");
  return { root, home, victim };
}

test("managed plugin promotion: a symlinked marketplace dir or symlinks inside it never copy outside files", () => {
  const f = fixture();
  try {
    const managed = join(f.root, "managed");
    mkdirSync(join(f.home, ".claude", "plugins"), { recursive: true });
    const run = () => promoteUserPlugins({ home: f.home, uid, managedDir: managed, base: {}, sandboxDir: "/etc/claude-code" });
    const register = (path: string) => {
      writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "p@evil": true } }));
      writeFileSync(join(f.home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({ evil: { source: { source: "directory", path } } }));
    };
    // 1. the marketplace directory itself is a symlink to another tenant's tree
    symlinkSync(f.victim, join(f.home, "mk"));
    register("/home/agent/mk");
    run();
    assert.equal(existsSync(join(managed, "plugins", "evil", "secret", "token.txt")), false);
    // 2. a real directory holding a symlinked subtree and a symlinked file
    rmSync(join(f.home, "mk"));
    mkdirSync(join(f.home, "mk2", ".claude-plugin"), { recursive: true });
    writeFileSync(join(f.home, "mk2", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "evil", plugins: [] }));
    writeFileSync(join(f.home, "mk2", "ok.txt"), "fine");
    symlinkSync(f.victim, join(f.home, "mk2", "linked"));
    symlinkSync(join(f.victim, "secret", "token.txt"), join(f.home, "mk2", "tok"));
    register("/home/agent/mk2");
    run();
    assert.equal(readFileSync(join(managed, "plugins", "evil", "ok.txt"), "utf8"), "fine");
    assert.equal(existsSync(join(managed, "plugins", "evil", "linked")), false);
    assert.equal(existsSync(join(managed, "plugins", "evil", "tok")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("openHomeDir and copyHomeTree refuse a symlinked component", () => {
  const f = fixture();
  try {
    symlinkSync(f.victim, join(f.home, "x"));
    assert.throws(() => openHomeDir(f.home, join(f.home, "x", "secret")), UnsafeHomePathError);
    assert.throws(() => copyHomeTree(f.home, join(f.home, "x"), join(f.root, "out")), UnsafeHomePathError);
    assert.equal(existsSync(join(f.root, "out")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("codex rollout/guidance: a symlinked CODEX_HOME is refused and the victim file is untouched", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".floq"), { recursive: true });
    symlinkSync(f.victim, join(f.home, ".floq", "codex"));
    assert.throws(() => syncCodexManagedGuidance(join(f.home, ".floq", "codex", "secret"), uid, "", f.home), UnsafeHomePathError);
    assert.throws(() => syncProtectedFloqSkill(join(f.home, ".floq", "codex"), f.root, uid, f.home));
    assert.equal(existsSync(join(f.victim, "secret", "AGENTS.md")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ownHomeTree does not chown through a symlinked directory", () => {
  const f = fixture();
  try {
    symlinkSync(f.victim, join(f.home, ".claude"));
    assert.throws(() => ownHomeTree(f.home, join(f.home, ".claude", "secret"), uid, 2), UnsafeHomePathError);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("removeHomeTree and project delete unlink links, never follow them", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, "d"));
    symlinkSync(f.victim, join(f.home, "d", "l"));
    writeFileSync(join(f.home, "d", "a"), "x");
    assert.equal(removeHomeTree(f.home, join(f.home, "d")), true);
    assert.equal(existsSync(join(f.victim, "secret", "token.txt")), true);
    symlinkSync(f.victim, join(f.home, "p"));
    assert.throws(() => removeHomeTree(f.home, join(f.home, "p", "secret")), UnsafeHomePathError);
    assert.equal(existsSync(join(f.victim, "secret", "token.txt")), true);
    const id = "11111111-1111-1111-1111-111111111111";
    mkdirSync(join(f.home, ".floq", "projects"), { recursive: true });
    symlinkSync(f.victim, join(f.home, ".floq", "projects", id));
    assert.equal(removeManagedCheckout(f.home, `.floq/projects/${id}`, "project"), "link-removed");
    assert.equal(existsSync(join(f.victim, "secret", "token.txt")), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
