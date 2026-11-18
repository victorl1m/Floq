// Run: node --experimental-strip-types --test e2e/wire-routing.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/components/canvas/wire-routing.ts";

const card = (x: number, y: number) => ({ x, y, width: 300, height: 200 });

test("a recruit wire to a child on the right leaves the right side and enters the left", () => {
  const curve = route(card(0, 0), card(600, 0), [], 0, true);
  assert.equal(curve.a.position, "right");
  assert.equal(curve.b.position, "left");
});

test("a recruit wire to a child above uses top and bottom, not a loop to the child's top", () => {
  const curve = route(card(0, 600), card(0, 0), [], 0, true);
  assert.equal(curve.a.position, "top");
  assert.equal(curve.b.position, "bottom");
});

test("a child below still gets bottom to top", () => {
  const curve = route(card(0, 0), card(0, 600), [], 0, true);
  assert.equal(curve.a.position, "bottom");
  assert.equal(curve.b.position, "top");
});

test("recruit and plain links route the same", () => {
  assert.deepEqual(route(card(0, 0), card(700, 300), [], 8, true), route(card(0, 0), card(700, 300), [], 8, false));
});
