import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeText, cosine, tfidfVectors, topKEdges, buildGraph, GRAPH_MAX_NODES } from "../dist/memoryGraph.js";
import * as client from "../../src/lib/memory-graph.ts";

const doc = (id: string, title: string, text: string, extra: object = {}) => ({ id, title, text, ...extra });
const corpus = [
  doc("a", "Deploy to production", "Run the deploy script to push the production build to the server"),
  doc("b", "Production deploy checklist", "Before the production deploy run the build and check the server logs"),
  doc("c", "Database backups", "Postgres backups run nightly and are stored in the backup bucket"),
  doc("d", "Backup restore", "Restore the postgres backup from the nightly bucket with pg_restore"),
  doc("e", "Cores do tema", "Usar as cores do tema escuro no painel de configuração"),
];

test("tokenizeText lowercases, folds accents and drops EN+PT stopwords", () => {
  assert.deepEqual(tokenizeText("The Configuração DO café, e a pg_restore!"), ["configuracao", "cafe", "pg_restore"]);
  assert.deepEqual(tokenizeText("a I o"), []);
});

test("cosine handles identical, orthogonal and zero vectors", () => {
  assert.equal(Math.round(cosine([1, 2, 3], [2, 4, 6]) * 1e6) / 1e6, 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("tfidfVectors are unit length", () => {
  for (const v of tfidfVectors([["a", "b", "b"], ["c"]])) assert.ok(Math.abs([...v.values()].reduce((s, w) => s + w * w, 0) - 1) < 1e-9);
});

test("keyword graph links related memories and keeps unrelated apart", () => {
  const g = buildGraph(corpus, { k: 2, min: 0.3 });
  assert.equal(g.mode, "keyword");
  const has = (x: string, y: string) => g.edges.some((e) => e.kind === "keyword" && ((e.source === x && e.target === y) || (e.source === y && e.target === x)));
  assert.ok(has("a", "b"));
  assert.ok(has("c", "d"));
  assert.ok(!has("a", "c"));
  assert.ok(!g.edges.some((e) => e.source === "e" || e.target === "e"), "the Portuguese outlier stays unlinked");
  for (const e of g.edges) assert.ok(e.weight > 0 && e.weight <= 1);
});

test("top-k keeps at most k neighbours per node and one edge per pair", () => {
  const sim = () => 0.9;
  const edges = topKEdges(5, sim, 2, 0.5, ["0", "1", "2", "3", "4"], "semantic");
  const deg = new Map<string, number>();
  for (const e of edges) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
  const pairs = new Set(edges.map((e) => [e.source, e.target].sort().join("-")));
  assert.equal(pairs.size, edges.length);
  assert.ok(edges.length <= 5 * 2);
  assert.equal(topKEdges(3, () => 0.4, 3, 0.5, ["a", "b", "c"], "keyword").length, 0, "below min is dropped");
});

test("semantic mode uses vectors when every node has one of the same size", () => {
  const v = (x: number[]) => Float32Array.from(x);
  const items = [doc("a", "", "x", { vector: v([1, 0, 0]) }), doc("b", "", "y", { vector: v([0.9, 0.1, 0]) }), doc("c", "", "z", { vector: v([0, 0, 1]) })];
  const g = buildGraph(items, { k: 1, min: 0.55 });
  assert.equal(g.mode, "semantic");
  assert.deepEqual(g.edges.map((e) => [e.kind, [e.source, e.target].sort().join("")]), [["semantic", "ab"]]);
  const mixed = buildGraph([items[0], doc("b", "", "y"), items[2]]);
  assert.equal(mixed.mode, "keyword");
  const sized = buildGraph([items[0], doc("b", "", "y", { vector: v([1, 0]) })]);
  assert.equal(sized.mode, "keyword");
});

test("supersedes edges are directed, weight 1, and need both ends in the node set", () => {
  const g = buildGraph([doc("old", "t", "alpha beta", { supersededBy: "new" }), doc("new", "t", "gamma"), doc("x", "t", "delta", { supersededBy: "gone" })]);
  assert.deepEqual(g.edges.filter((e) => e.kind === "supersedes"), [{ source: "old", target: "new", weight: 1, kind: "supersedes" }]);
});

test("caps at 400 nodes and clamps k and min", () => {
  const many = Array.from({ length: 450 }, (_, i) => doc("m" + i, "topic " + (i % 9), "shared words topic " + (i % 9) + " item " + i));
  const g = buildGraph(many, { k: 99, min: -3 });
  assert.equal(g.nodes.length, GRAPH_MAX_NODES);
  const deg = new Map<string, number>();
  for (const e of g.edges) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); }
  assert.ok(g.edges.length <= 400 * 10);
  assert.deepEqual(buildGraph([]), { nodes: [], edges: [], mode: "keyword" });
});

test("client fallback port gives the same graph", () => {
  assert.deepEqual(client.buildGraph(corpus, { k: 2, min: 0.3 }), buildGraph(corpus, { k: 2, min: 0.3 }));
  assert.deepEqual(client.tokenizeText("Configuração do café"), tokenizeText("Configuração do café"));
});
