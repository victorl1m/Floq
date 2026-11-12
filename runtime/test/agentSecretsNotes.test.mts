import test from "node:test";
import assert from "node:assert/strict";
import { parseNoteFields } from "../dist/notes.js";
import { assertCanRecruit } from "../dist/orchestrator.js";
import { HttpError } from "../dist/errors.js";
import { getAgentRole, parseRoleId } from "../dist/roles.js";

test("note validation", () => {
  assert.deepEqual(parseNoteFields({ x: 1, y: 2 }, true), { x: 1, y: 2 });
  assert.deepEqual(parseNoteFields({ text: "hi", color: "pink", w: 120, h: 2000 }, false), { text: "hi", color: "pink", w: 120, h: 2000 });
  assert.throws(() => parseNoteFields({ x: 1 }, true));
  for (const bad of [{ text: "x".repeat(20001) }, { color: "red" }, { w: 119 }, { h: 2001 }, { x: Infinity }, { x: NaN }, { y: "1" }, { text: 5 }]) {
    assert.throws(() => parseNoteFields(bad, false), HttpError, JSON.stringify(bad).slice(0, 40));
  }
  assert.throws(() => parseNoteFields(null, false));
  assert.deepEqual(parseNoteFields({ text: "x".repeat(20000) }, false).text?.length, 20000);
});

const row = (id: string, title: string, role: string | null, project = "p") => ({ id, title, role, cwd: project });
const same = (a: { cwd: string | null }, b: { cwd: string | null }) => a.cwd === b.cwd;

test("recruit: orchestrator allowed, others get 403 naming the project's orchestrators", () => {
  const all = [row("o1", "Boss", "orchestrator"), row("w1", "Worker", null), row("o2", "Other", "orchestrator", "q")];
  assert.doesNotThrow(() => assertCanRecruit(all[0], all, same));
  assert.throws(() => assertCanRecruit(all[1], all, same), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 403);
    assert.equal(e.message, 'Only the orchestrator can recruit agents. Ask Boss (o1) to recruit for you: floq ask o1 "Please recruit a <role> agent to <task>".');
    return true;
  });
  assert.throws(() => assertCanRecruit(row("w2", "W2", null, "z"), all, same), /no orchestrator yet.*Set as orchestrator/);
});

test("role presets: orchestrator is a valid preset; unknown role rejected (PATCH validation)", () => {
  assert.equal(parseRoleId("orchestrator")?.id, "orchestrator");
  assert.equal(parseRoleId(null), null);
  assert.equal(parseRoleId("generalist"), null);
  assert.throws(() => parseRoleId("god"), HttpError);
  assert.throws(() => parseRoleId(5), HttpError);
  assert.match(getAgentRole("orchestrator")!.prompt, /only the orchestrator can recruit/i);
});
