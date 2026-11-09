// Run: node --experimental-strip-types --test e2e/memory-groups.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { groupMemories, buildDisplay, communities, displayIdOf, litNodes, autoExpand, groupNodeId, groupRadius } from "../src/lib/memory-groups.ts";
import { buildGraph } from "../src/lib/memory-graph.ts";
import { makeMemories } from "./harness/fixture.ts";

const mems = makeMemories(60).filter((m) => !m.invalidatedAt);
const gm = mems.map((m) => ({ id: m.id, type: m.type, title: m.title, text: m.text, author: m.author }));
const graph = buildGraph(gm.map((m) => ({ id: m.id, title: m.title, text: m.text })), { k: 3, min: 0.2 });
const edges = graph.edges;

test("type groups cover every memory exactly once, with labels and token colours", () => {
  const g = groupMemories(gm, edges, "type");
  assert.deepEqual(g.map((x) => x.label), ["Facts", "Decisions", "Procedures", "Episodes"]);
  assert.equal(g.reduce((n, x) => n + x.members.length, 0), gm.length);
  assert.deepEqual(g.map((x) => x.color), ["type:fact", "type:decision", "type:procedure", "type:episode"]);
  assert.deepEqual(groupMemories(gm, edges, "none"), []);
});

test("author groups: null author is You, biggest first", () => {
  const g = groupMemories(gm, edges, "author");
  assert.ok(g.some((x) => x.label === "You"));
  for (let i = 1; i < g.length; i++) assert.ok(g[i - 1].members.length >= g[i].members.length);
  assert.equal(g.reduce((n, x) => n + x.members.length, 0), gm.length);
});

test("topic groups come from the similarity edges: deterministic, partition, named by keywords, capped", () => {
  const a = groupMemories(gm, edges, "topic"), b = groupMemories(gm, edges, "topic");
  assert.deepEqual(a, b);
  assert.ok(a.length >= 3 && a.length <= 12);
  assert.equal(a.reduce((n, x) => n + x.members.length, 0), gm.length);
  assert.equal(new Set(a.flatMap((x) => x.members)).size, gm.length);
  // memories of one fixture topic (same title prefix) mostly land in the same group
  const topicOf = (id: string) => a.findIndex((g) => g.members.includes(id));
  const db = gm.filter((m) => m.title.startsWith("Database:")).map((m) => topicOf(m.id));
  const top = Math.max(...[...new Set(db)].map((t) => db.filter((x) => x === t).length));
  assert.ok(top / db.length >= 0.7, `database memories split too much: ${db}`);
  assert.ok(a.every((g) => g.label.length > 0));
});

test("communities: two cliques joined by one weak edge stay two communities", () => {
  const ids = ["a", "b", "c", "x", "y", "z"], e = (s: string, t: string, w = 0.8) => ({ source: s, target: t, weight: w, kind: "keyword" as const });
  const lab = communities(ids, [e("a", "b"), e("b", "c"), e("a", "c"), e("x", "y"), e("y", "z"), e("x", "z"), e("c", "x", 0.2)], 0.1);
  assert.equal(new Set(["a", "b", "c"].map((i) => lab.get(i))).size, 1);
  assert.equal(new Set(["x", "y", "z"].map((i) => lab.get(i))).size, 1);
  assert.notEqual(lab.get("a"), lab.get("x"));
});

test("collapsed display: one bubble per group, one aggregated edge per pair with the member link count, supersedes kept apart", () => {
  const groups = groupMemories(gm, edges, "type");
  const withSup = [...edges, { source: gm[0].id, target: gm[1].id, weight: 1, kind: "supersedes" as const }];
  const d = buildDisplay(gm, groups, new Set(), withSup);
  assert.equal(d.nodes.length, groups.length);
  assert.ok(d.nodes.every((n) => n.kind === "group"));
  const sims = d.edges.filter((e) => e.kind !== "supersedes");
  assert.equal(new Set(sims.map((e) => [e.source, e.target].sort().join("|"))).size, sims.length, "one similarity edge per pair");
  const crossLinks = edges.filter((e) => d.groupOf.get(e.source) !== d.groupOf.get(e.target)).length;
  assert.equal(sims.reduce((n, e) => n + e.count, 0), crossLinks, "every cross-group link is counted exactly once");
  assert.ok(sims.every((e) => e.aggregated));
  assert.ok(d.edges.filter((e) => e.kind === "supersedes").length <= 1);
});

test("expanding a group shows its members in place, keeps other groups collapsed, and seeds positions from the bubble", () => {
  const groups = groupMemories(gm, edges, "type");
  const open = groups[0];
  const d = buildDisplay(gm, groups, new Set([open.key]), edges);
  assert.equal(d.nodes.length, open.members.length + groups.length - 1);
  const member = d.nodes.find((n) => n.memoryId === open.members[0])!;
  assert.deepEqual(member.seedFrom, [groupNodeId(open.key)]);
  assert.equal(d.hulls.length, 1);
  assert.equal(d.hulls[0].key, open.key);
  const collapsedBack = buildDisplay(gm, groups, new Set(), edges).nodes.find((n) => n.groupKey === open.key)!;
  assert.deepEqual(collapsedBack.seedFrom, open.members);
  // edges between two expanded members keep their own weight and count 1
  const all = buildDisplay(gm, groups, new Set(groups.map((g) => g.key)), edges);
  assert.equal(all.nodes.length, gm.length);
  assert.equal(all.edges.length, edges.length);
  assert.ok(all.edges.every((e) => e.count === 1 && !e.aggregated));
});

test("search helpers: lit nodes with counts, auto expand only for a few matches, display ids", () => {
  const groups = groupMemories(gm, edges, "type");
  const d = buildDisplay(gm, groups, new Set(), edges);
  const some = new Set(gm.filter((m) => m.type === "fact").slice(0, 3).map((m) => m.id));
  assert.deepEqual([...litNodes(some, d.groupOf, new Set())], [[groupNodeId("type:fact"), 3]]);
  assert.deepEqual([...autoExpand(groups, some)], ["type:fact"]);
  assert.equal(autoExpand(groups, new Set(gm.slice(0, 20).map((m) => m.id))).size, 0, "many matches stay collapsed");
  assert.equal(autoExpand(groups, null).size, 0);
  assert.equal(displayIdOf(gm[0].id, d.groupOf, new Set()), groupNodeId(d.groupOf.get(gm[0].id)!));
  assert.equal(displayIdOf(gm[0].id, d.groupOf, new Set([d.groupOf.get(gm[0].id)!])), gm[0].id);
});

test("group radius grows with the member count and is capped", () => {
  assert.ok(groupRadius(4) < groupRadius(40));
  assert.equal(groupRadius(100000), 62);
});
