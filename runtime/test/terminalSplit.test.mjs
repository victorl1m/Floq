import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../../src/lib/runtime/terminal-split.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { chooseSplitPeer, resolveSplitPeer, visibleSplitIds } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

test("split selection only uses already-open sessions and rejects the primary session", () => {
  const opened = new Set(["primary", "peer"]);
  assert.equal(chooseSplitPeer("primary", "peer", opened), "peer");
  assert.equal(chooseSplitPeer("primary", "primary", opened), null);
  assert.equal(chooseSplitPeer("primary", "not-open", opened), null);
});

test("split state clears when either pane is deleted, sleeps, or the primary selection falls back", () => {
  assert.equal(resolveSplitPeer("primary", "peer", new Set(["primary", "peer"])), "peer");
  assert.equal(resolveSplitPeer("primary", "peer", new Set(["primary"])), null);
  assert.equal(resolveSplitPeer("primary", "peer", new Set(["peer"])), null);
  assert.equal(resolveSplitPeer(null, "peer", new Set(["peer"])), null);
  assert.equal(resolveSplitPeer("primary", "primary", new Set(["primary"])), null);
});

test("three or more open terminals leave exactly two visible comparison panes", () => {
  assert.deepEqual(
    [...visibleSplitIds(["primary", "peer", "other", "shell"], "primary", "peer")].sort(),
    ["peer", "primary"],
  );
  assert.equal(visibleSplitIds(["primary", "peer", "other"], "primary", "deleted").size, 0);
});
