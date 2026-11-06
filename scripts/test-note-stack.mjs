import test from "node:test";
import assert from "node:assert/strict";
import { stackNotes } from "../src/components/canvas/note-placement.ts";

const note = (id, kind, title, w = 240, h = 180) => ({ id, kind, title, w, h });
const overlaps = (a, b, pa, pb) => pa.x < pb.x + b.w && pa.x + a.w > pb.x && pa.y < pb.y + b.h && pa.y + a.h > pb.y;

test("notes stack in one column left of the agents, system then memory then notes", () => {
  const notes = [note("n1", "note", "b"), note("m1", "memory", "z"), note("s1", "system", "z"), note("n0", "note", "a")];
  const pos = stackNotes(notes, 1000, 0);
  assert.deepEqual(Object.keys(pos).sort(), ["m1", "n0", "n1", "s1"]);
  const xs = new Set(Object.values(pos).map((p) => p.x));
  assert.equal(xs.size, 1);
  assert.ok([...xs][0] + 240 < 1000);
  const order = Object.entries(pos).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
  assert.deepEqual(order, ["s1", "m1", "n0", "n1"]);
});

test("tall stacks wrap into more columns and nothing overlaps", () => {
  const notes = Array.from({ length: 20 }, (_, i) => note("n" + i, "note", String(i).padStart(2, "0"), 200 + (i % 3) * 40, 200));
  const pos = stackNotes(notes, 0, 0);
  assert.ok(new Set(Object.values(pos).map((p) => p.x)).size > 1);
  for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) assert.ok(!overlaps(notes[i], notes[j], pos[notes[i].id], pos[notes[j].id]));
  for (const n of notes) assert.ok(pos[n.id].x + n.w < 0);
});

test("no notes gives no positions", () => assert.deepEqual(stackNotes([], 0, 0), {}));
