import test from "node:test";
import assert from "node:assert/strict";
import { layoutFloors, nodePosition, resolveLayoutParents } from "../../src/components/canvas/layout.ts";
import { recruitEndpoints } from "../../src/components/canvas/wire-endpoints.ts";
import { Position } from "@xyflow/react";
import { route } from "../../src/components/canvas/wire-routing.ts";

test("recruit parents control layout with two orchestrators, regardless of other incoming links", () => {
  const sessions = [
    { id: "orch-a", parentId: null },
    { id: "orch-b", parentId: null },
    { id: "child-a", parentId: "orch-a" },
    { id: "child-b", parentId: "orch-b" },
  ];
  const links = [
    { from: "orch-b", to: "child-a", kind: "manual" }, // incidental link appears before the real recruit relationship
    { from: "orch-a", to: "child-a", kind: "recruit" },
    { from: "orch-a", to: "child-b", kind: "recruit" },
  ];
  const parents = resolveLayoutParents(sessions, links);
  const positions = layoutFloors(sessions.map((s) => ({ ...s, floorId: "main", parentId: parents.get(s.id) ?? null })), ["main"]).positions;

  assert.ok(positions["child-a"].y > positions["orch-a"].y);
  assert.ok(positions["child-b"].y > positions["orch-b"].y);
  assert.notEqual(positions["child-a"].x, positions["orch-b"].x);
});

test("saved placements remain fixed while a newly recruited agent uses its parent-relative layout slot", () => {
  const sessions = [
    { id: "orch-a", parentId: null },
    { id: "orch-b", parentId: null },
    { id: "child-a", parentId: "orch-a" },
    { id: "child-b", parentId: "orch-b" },
  ];
  const parents = resolveLayoutParents(sessions, [{ from: "orch-b", to: "child-a", kind: "recruit" }]);
  const automatic = layoutFloors(sessions.map((s) => ({ ...s, floorId: "main", parentId: parents.get(s.id) ?? null })), ["main"]).positions;
  const saved = { "orch-a": { x: 1200, y: 400 }, "orch-b": { x: -900, y: 650 }, "child-a": { x: 7000, y: -200 } };

  assert.deepEqual(nodePosition("orch-a", saved, automatic), saved["orch-a"]);
  assert.deepEqual(nodePosition("orch-b", saved, automatic), saved["orch-b"]);
  assert.deepEqual(nodePosition("child-a", saved, automatic), saved["child-a"]);
  const initial = nodePosition("child-b", saved, automatic, "orch-b");
  const placed = nodePosition("child-b", saved, automatic, "orch-b", 320, 520, 320, [{ ...initial, width: 900, height: 500 }]);
  assert.ok(placed.y > nodePosition("orch-b", saved, automatic).y);
  assert.ok(placed.x >= initial.x + 960);
});

test("incidental descendant-to-root recruit links do not make layout depend on item order", () => {
  const links = [{ from: "child", to: "root", kind: "recruit" }];
  const a = [{ id: "root", parentId: null }, { id: "child", parentId: "root" }];
  const b = [...a].reverse();
  const first = layoutFloors(a.map((s) => ({ ...s, floorId: "main", parentId: resolveLayoutParents(a, links).get(s.id) ?? null })), ["main"]).positions;
  const second = layoutFloors(b.map((s) => ({ ...s, floorId: "main", parentId: resolveLayoutParents(b, links).get(s.id) ?? null })), ["main"]).positions;
  assert.deepEqual(first, second);
  assert.ok(first.child.y > first.root.y);
});

test("recruit wire endpoints stay on the parent's bottom and child's top for expanded or collapsed sizes", () => {
  const parent = { x: 100, y: 400, width: 500, height: 320 };
  const child = { x: 100, y: 900, width: 500, height: 40 };
  const expanded = recruitEndpoints(parent, child, 16);
  assert.deepEqual(expanded, {
    a: { x: 366, y: 720, position: "bottom" },
    b: { x: 366, y: 900, position: "top" },
  });
  const collapsed = recruitEndpoints({ ...parent, height: 40 }, { ...child, height: 320 }, -16);
  assert.deepEqual(collapsed, {
    a: { x: 334, y: 440, position: "bottom" },
    b: { x: 334, y: 900, position: "top" },
  });
});

test("the rendered recruit route preserves bottom-to-top endpoints and applies one fan across obstacles", () => {
  const parent = { x: 100, y: 400, width: 500, height: 320 };
  const child = { x: 100, y: 900, width: 500, height: 320 };
  const obstacle = { x: 280, y: 760, width: 140, height: 120 };
  const curve = route(parent, child, [obstacle], 16, true);
  assert.deepEqual([curve.a.position, curve.b.position], [Position.Bottom, Position.Top]);
  assert.deepEqual([curve.a.x, curve.a.y], [366, 720]);
  assert.deepEqual([curve.b.x, curve.b.y], [366, 900]);
  assert.ok(curve.c2.y < curve.b.y, "the final control point approaches the target from above");

  const generic = route(parent, { ...child, y: 0 }, [], 0);
  assert.equal(generic.b.position, Position.Bottom, "non-recruit links keep geometry-based anchors");
});
