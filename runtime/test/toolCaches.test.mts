import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairToolCaches, USER_TOOL_CACHES } from "../src/shards.ts";

test("the npm cache is in the repaired set (npx, and so the bundled context7 MCP, needs it)", () => {
  assert.ok(USER_TOOL_CACHES.includes(".npm"));
});

test("repairToolCaches walks the cache, keeps ownership with the user, tolerates a missing cache and never follows symlinks", (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const uid = process.getuid!();
  assert.doesNotThrow(() => repairToolCaches(home, uid), "no ~/.npm yet");
  mkdirSync(join(home, ".npm/_cacache/index-v5/a9"), { recursive: true });
  writeFileSync(join(home, ".npm/_cacache/index-v5/a9/entry"), "x");
  const outside = mkdtempSync(join(tmpdir(), "floq-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(home, ".npm/link"));
  repairToolCaches(home, uid);
  assert.equal(statSync(join(home, ".npm/_cacache/index-v5/a9/entry")).uid, uid);
});
