// Run: node --experimental-strip-types --test e2e/branch-hide.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { hiddenByBranch } from "../src/lib/branch-tags.ts";

const all = (_: unknown) => true;
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: "s" + i, state: "sleeping", lead: false }));

test("11 sessions all tagged with another branch: none hidden (canvas never empty)", () => {
  const sessions = mk(11);
  const tags = Object.fromEntries(sessions.map((s) => [s.id, { branch: "old" }]));
  assert.equal(hiddenByBranch(sessions, "main", tags, all).size, 0);
});
test("branch comparison is case-insensitive", () => {
  const sessions = mk(3);
  const tags = Object.fromEntries(sessions.map((s) => [s.id, { branch: "Main" }]));
  assert.equal(hiddenByBranch(sessions, "main", tags, all).size, 0);
});
test("lead and running sessions are never hidden; others still are", () => {
  const sessions = [{ id: "a", state: "sleeping", lead: false }, { id: "lead", state: "sleeping", lead: true }, { id: "run", state: "running", lead: false }, { id: "b", state: "sleeping", lead: false }];
  const tags = { a: { branch: "x" }, lead: { branch: "x" }, run: { branch: "x" } };
  assert.deepEqual([...hiddenByBranch(sessions, "main", tags, all)], ["a"]);
});
