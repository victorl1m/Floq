// Run: node --experimental-strip-types --test e2e/memory-force.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { layoutForce, bounds, fitTransform, stretchToAspect } from "../src/lib/memory-force.ts";
import { buildGraph } from "../src/lib/memory-graph.ts";

const dist = (m: Map<string, { x: number; y: number }>, a: string, b: string) => Math.hypot(m.get(a)!.x - m.get(b)!.x, m.get(a)!.y - m.get(b)!.y);
const ring = (ids: string[]) => ids.map((id, i) => ({ source: id, target: ids[(i + 1) % ids.length], weight: 0.8 }));
const A = ["a1", "a2", "a3", "a4", "a5"], B = ["b1", "b2", "b3", "b4", "b5"];
const nodes = [...A, ...B].map((id) => ({ id }));
const links = [...ring(A), ...ring(B)];

test("deterministic: same input gives the same positions", () => {
  assert.deepEqual([...layoutForce(nodes, links)], [...layoutForce(nodes, links)]);
  assert.notDeepEqual([...layoutForce(nodes, links, { seed: 2 })], [...layoutForce(nodes, links, { seed: 3 })]);
});

test("clusters emerge: members of a ring sit closer than nodes of the other ring", () => {
  const p = layoutForce(nodes, links);
  const within = (dist(p, "a1", "a2") + dist(p, "a2", "a3") + dist(p, "b1", "b2") + dist(p, "b3", "b4")) / 4;
  const across = (dist(p, "a1", "b1") + dist(p, "a3", "b3") + dist(p, "a5", "b2") + dist(p, "a2", "b4")) / 4;
  assert.ok(within < across * 0.8, `within ${within} across ${across}`);
});

test("pinned nodes end up nearer the centre than unpinned ones", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: "n" + i, pinned: i < 4 }));
  const ls = many.slice(1).map((n, i) => ({ source: "n" + i, target: n.id, weight: 0.6 }));
  const p = layoutForce(many, ls);
  const r = (id: string) => Math.hypot(p.get(id)!.x, p.get(id)!.y);
  const pinned = (r("n0") + r("n1") + r("n2") + r("n3")) / 4;
  const rest = many.slice(4).reduce((s, n) => s + r(n.id), 0) / 36;
  assert.ok(pinned < rest, `pinned ${pinned} rest ${rest}`);
});

test("positions are finite, unknown link ends ignored, empty input ok", () => {
  const p = layoutForce([{ id: "x" }, { id: "y" }], [{ source: "x", target: "nope", weight: 1 }, { source: "x", target: "x", weight: 1 }]);
  for (const v of p.values()) assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y));
  assert.equal(layoutForce([], []).size, 0);
  assert.equal(p.size, 2);
});

test("400 nodes lay out within a bounded time", () => {
  const items = Array.from({ length: 400 }, (_, i) => ({ id: "m" + i, title: "topic " + (i % 12), text: "words shared topic " + (i % 12) + " item " + i }));
  const g = buildGraph(items);
  const t0 = performance.now();
  const p = layoutForce(g.nodes, g.edges);
  const ms = performance.now() - t0;
  assert.equal(p.size, 400);
  assert.ok(ms < 1500, `took ${ms}ms`);
  console.log(`# 400-node layout ${ms.toFixed(0)}ms, ${g.edges.length} edges`);
});

test("bounds and fitTransform put the box inside the viewport", () => {
  const b = bounds([{ x: -100, y: -50 }, { x: 300, y: 150 }], 0);
  const t = fitTransform(b, 400, 200);
  assert.equal(t.k, 1);
  assert.equal(t.tx, 400 / 2 - 100);
  assert.equal(fitTransform(b, 800, 400).k, 1.5, "zoom is capped");
  const small = fitTransform(bounds([{ x: 0, y: 0 }], 0), 800, 400);
  assert.equal(small.k, 1.5);
  const big = fitTransform(bounds([{ x: 0, y: 0 }, { x: 4000, y: 100 }], 0), 800, 400);
  assert.ok(big.k < 0.25);
});

test("fitTransform pad leaves the margin; stretchToAspect matches the pane aspect and keeps order", () => {
  const b = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const t = fitTransform(b, 1000, 500, { pad: 0.06, maxK: 10 });
  assert.ok(Math.abs(100 * t.k - 500 * 0.88) < 1e-9);
  const p = layoutForce(nodes, links);
  const s = stretchToAspect(p, 2);
  const bb = bounds(s.values(), 0);
  assert.ok(Math.abs((bb.maxX - bb.minX) / (bb.maxY - bb.minY) - 2) < 0.05);
  assert.equal(s.size, p.size);
  assert.deepEqual([...stretchToAspect(s, 2)].map(([id, q]) => [id, Math.round(q.x), Math.round(q.y)]), [...s].map(([id, q]) => [id, Math.round(q.x), Math.round(q.y)]));
});

import { ForceSim, placeLabels, pickNode } from "../src/lib/memory-force.ts";
const simNodes = (n: number, pinned = 0) => Array.from({ length: n }, (_, i) => ({ id: "n" + i, pinned: i < pinned, r: 8 }));

test("ForceSim: deterministic, cools down, never overlaps discs, stays finite", () => {
  const ns = [...A, ...B].map((id) => ({ id, r: 8 }));
  const run = () => { const s = new ForceSim(ns, links, { seed: 4 }); s.run(400); return s; };
  const s1 = run(), s2 = run();
  assert.deepEqual([...s1.positions()], [...s2.positions()]);
  assert.ok(s1.settled, "alpha cooled below alphaMin");
  for (let i = 0; i < s1.n; i++) { assert.ok(Number.isFinite(s1.x[i]) && Number.isFinite(s1.y[i])); for (let j = i + 1; j < s1.n; j++) assert.ok(Math.hypot(s1.x[i] - s1.x[j], s1.y[i] - s1.y[j]) >= 8 + 8 - 1.5, "discs overlap"); }
  const p = s1.positions();
  const mean = (pairs: Array<[string, string]>) => pairs.reduce((t, [a, b]) => t + dist(p, a, b), 0) / pairs.length;
  const inRing = (g: string[]) => g.flatMap((a, i) => g.slice(i + 1).map((b) => [a, b] as [string, string]));
  const within = mean([...inRing(A), ...inRing(B)]), across = mean(A.flatMap((a) => B.map((b) => [a, b] as [string, string])));
  assert.ok(within < across, `within ${within} across ${across}`);
});

test("ForceSim: reheat wakes it up, a dragged node stays fixed and drags its neighbours, release lets it relax", () => {
  const ns = [...A, ...B].map((id) => ({ id, r: 8 }));
  const s = new ForceSim(ns, links, { seed: 4 });
  s.run(400);
  assert.ok(s.settled);
  const i = s.indexOf("a1"), j = s.indexOf("a2"), far = s.indexOf("b3");
  const j0 = { x: s.x[j], y: s.y[j] }, far0 = { x: s.x[far], y: s.y[far] };
  s.alphaTarget = 0.3; s.reheat(0.3);
  s.fx[i] = s.x[i] + 300; s.fy[i] = s.y[i];
  for (let t = 0; t < 120; t++) s.tick();
  assert.equal(s.x[i], s.fx[i]);
  assert.ok(Math.hypot(s.x[j] - j0.x, s.y[j] - j0.y) > 20, "neighbour follows the dragged node");
  assert.ok(!s.settled, "stays alive while dragging");
  s.fx[i] = NaN; s.fy[i] = NaN; s.alphaTarget = 0;
  s.run(600);
  assert.ok(s.settled);
  assert.ok(Number.isFinite(far0.x));
});

test("ForceSim: aspect stretches the cloud to the pane and pinned nodes sit nearer the centre", () => {
  const ns = simNodes(60, 4);
  const ls = ns.slice(1).map((n, i) => ({ source: "n" + i, target: n.id, weight: 0.5 }));
  const s = new ForceSim(ns, ls, { seed: 2, aspect: 2.2 });
  s.run(500);
  const b = bounds(s.positions().values(), 0);
  const ratio = (b.maxX - b.minX) / (b.maxY - b.minY);
  assert.ok(ratio > 1.7 && ratio < 2.8, `ratio ${ratio} (aspect 2.2)`);
  const rad = (id: string) => Math.hypot(s.x[s.indexOf(id)], s.y[s.indexOf(id)]);
  assert.ok((rad("n0") + rad("n1") + rad("n2") + rad("n3")) / 4 < ns.slice(4).reduce((t, n) => t + rad(n.id), 0) / 56);
});

test("ForceSim: 300 nodes, one tick fits the frame budget", () => {
  const ns = simNodes(300);
  const ls = ns.slice(1).flatMap((n, i) => [{ source: "n" + i, target: n.id, weight: 0.5 }, { source: "n" + ((i * 7) % 300), target: n.id, weight: 0.4 }]);
  const s = new ForceSim(ns, ls);
  s.run(20);
  const t0 = performance.now(); for (let k = 0; k < 20; k++) s.tick(); const per = (performance.now() - t0) / 20;
  console.log(`# ForceSim tick at 300 nodes: ${per.toFixed(2)}ms`);
  assert.ok(per < 8, `tick ${per}ms`);
});

test("placeLabels: forced labels always placed, others never overlap (padding included) and are capped", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: "l" + i, sx: (i * 37) % 400, sy: (i * 53) % 300, r: 6, w: 90, force: i === 150 }));
  const out = placeLabels(items, { w: 400, h: 300 }, { max: 25, pad: 4 });
  assert.ok(out.some((l) => l.id === "l150"));
  assert.ok(out.length <= 26);
  const free = out.filter((l) => l.id !== "l150");
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) assert.ok(!(free[i].x0 < free[j].x1 && free[i].x1 > free[j].x0 && free[i].y0 < free[j].y1 && free[i].y1 > free[j].y0));
  assert.deepEqual(placeLabels([{ id: "off", sx: -500, sy: 10, r: 5, w: 40 }], { w: 400, h: 300 }), []);
});

test("pickNode: topmost node under the pointer, respects zoom and pan, -1 on empty space", () => {
  const xs = [0, 5, 100], ys = [0, 0, 0], rs = [10, 10, 10];
  assert.equal(pickNode(xs, ys, rs, { k: 1, tx: 200, ty: 200 }, 203, 200), 1, "later node is on top");
  assert.equal(pickNode(xs, ys, rs, { k: 2, tx: 0, ty: 0 }, 200, 0), 2);
  assert.equal(pickNode(xs, ys, rs, { k: 1, tx: 0, ty: 0 }, 50, 50), -1);
});

test("ForceSim: members of an expanded group stay together and outsiders keep out of the hull", () => {
  const members = Array.from({ length: 12 }, (_, i) => ({ id: "m" + i, r: 8, group: "g" }));
  const outsiders = Array.from({ length: 6 }, (_, i) => ({ id: "o" + i, r: 30, charge: 3 }));
  const ls = members.slice(1).map((m, i) => ({ source: "m" + i, target: m.id, weight: 0.5 }));
  const s = new ForceSim([...members, ...outsiders], ls, { seed: 3 });
  s.run(600);
  const idx = (id: string) => s.indexOf(id);
  const mi = members.map((m) => idx(m.id));
  const cx = mi.reduce((t, i) => t + s.x[i], 0) / mi.length, cy = mi.reduce((t, i) => t + s.y[i], 0) / mi.length;
  const R = Math.max(...mi.map((i) => Math.hypot(s.x[i] - cx, s.y[i] - cy) + s.r[i]));
  for (const o of outsiders) { const i = idx(o.id); assert.ok(Math.hypot(s.x[i] - cx, s.y[i] - cy) >= R + s.r[i] - 2, `${o.id} inside the hull`); }
});
