import test from "node:test";
import assert from "node:assert/strict";
import { HOME_CWD, wantsHomeShell } from "../src/homeShell.ts";
import { safeRelative } from "../src/shard.ts";

test("a project-less shell asking for home resolves to the home root", () => {
  assert.equal(wantsHomeShell({ provider: "shell", home: true }), true);
  assert.equal(safeRelative(HOME_CWD), "");
});

test("home is off unless explicitly true", () => {
  assert.equal(wantsHomeShell({ provider: "shell" }), false);
  assert.equal(wantsHomeShell({ provider: "shell", home: false }), false);
  assert.equal(wantsHomeShell({ provider: "claude" }), false);
});

test("home never combines with client-supplied placement and is shell-only", () => {
  assert.throws(() => wantsHomeShell({ provider: "shell", home: "yes" }), /boolean/);
  assert.throws(() => wantsHomeShell({ provider: "claude", home: true }), /only supported for shell/);
  for (const extra of [{ cwd: "../etc" }, { cwd: "x" }, { projectId: "p" }, { workspaceId: "w" }, { gitUrl: "u" }, { isolated: true }]) {
    assert.throws(() => wantsHomeShell({ provider: "shell", home: true, ...extra }), /cannot be combined/);
  }
});
