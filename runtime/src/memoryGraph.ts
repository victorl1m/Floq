/**
 * Pure helpers behind the Memory graph view: tokenizing, similarity and top-k edge building. No Redis, no I/O.
 * src/lib/memory-graph.ts is a verbatim port used as the client-side fallback (runtime/test/memoryGraph.test.mts checks parity).
 */

export type GraphEdgeKind = "semantic" | "keyword" | "supersedes";
export interface GraphEdge { source: string; target: string; weight: number; kind: GraphEdgeKind }
export interface GraphInput { id: string; title: string; text: string; supersededBy?: string | null; vector?: ArrayLike<number> | null }

export const GRAPH_MAX_NODES = 400;
export const GRAPH_DEFAULT_K = 3;
export const GRAPH_DEFAULT_MIN = 0.55;

const STOPWORDS = new Set((
  "a about after again all also am an and any are as at be because been before being but by can could did do does doing for from had has have " +
  "he her here him his how i if in into is it its just me more most my no nor not of on once only or other our out over own same she should so " +
  "some such than that the their them then there these they this those through to too under until up very was we were what when where which " +
  "while who why will with would you your " +
  "a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre entre e ou mas que se como mais menos muito muita " +
  "ja nao sim ao aos ele ela eles elas eu tu voce voces nos nosso nossa seu sua seus suas meu minha isso isto esse essa este esta aquele aquela " +
  "ser estar foi sao era tem ter tinha ha so tambem quando onde qual quais porque pelo pela pelos pelas num numa"
).split(/\s+/));

/** Lowercase, accent-folded word tokens without stopwords and one-letter noise. */
export function tokenizeText(text: string): string[] {
  const folded = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const out: string[] = [];
  for (const t of folded.split(/[^a-z0-9_]+/)) if (t.length > 1 && !STOPWORDS.has(t)) out.push(t);
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Sparse TF-IDF vectors (L2-normalised) so a keyword similarity is a plain dot product; document frequency over the whole set. */
export function tfidfVectors(docs: string[][]): Array<Map<string, number>> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * (Math.log(1 + n / (df.get(t) ?? 1)));
      v.set(t, w); norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

function sparseDot(a: Map<string, number>, b: Map<string, number>): number {
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of s) { const o = l.get(t); if (o !== undefined) dot += w * o; }
  return dot;
}

/** Top-k neighbours per node over a pairwise similarity, kept when >= min; an undirected pair appears once (max weight). */
export function topKEdges(n: number, sim: (i: number, j: number) => number, k: number, min: number, ids: string[], kind: GraphEdgeKind): GraphEdge[] {
  const pairs = new Map<string, { i: number; j: number; w: number }>();
  for (let i = 0; i < n; i++) {
    const best: Array<{ j: number; w: number }> = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const w = sim(i, j);
      if (w < min) continue;
      if (best.length < k) best.push({ j, w });
      else {
        let worst = 0;
        for (let x = 1; x < best.length; x++) if (best[x].w < best[worst].w) worst = x;
        if (w > best[worst].w) best[worst] = { j, w };
      }
    }
    for (const { j, w } of best) {
      const a = Math.min(i, j), b = Math.max(i, j), key = a + ":" + b;
      const prev = pairs.get(key);
      if (!prev || w > prev.w) pairs.set(key, { i: a, j: b, w });
    }
  }
  return [...pairs.values()]
    .map(({ i, j, w }) => ({ source: ids[i], target: ids[j], weight: Math.round(w * 1000) / 1000, kind }))
    .sort((x, y) => y.weight - x.weight || (x.source + x.target).localeCompare(y.source + y.target));
}

export interface GraphResult { nodes: Array<{ id: string }>; edges: GraphEdge[]; mode: "semantic" | "keyword" }

/**
 * Nodes (capped, newest input first is the caller's order) + supersedes edges + top-k similarity edges.
 * Semantic when EVERY node carries a vector of the same length, keyword (TF-IDF cosine) otherwise.
 * Keyword scores run lower than embedding scores, so the keyword threshold is scaled by 0.6 of `min` (0.55 -> 0.33).
 */
export function buildGraph(input: GraphInput[], opts: { k?: number; min?: number; cap?: number } = {}): GraphResult {
  const k = Math.min(Math.max(Math.trunc(opts.k ?? GRAPH_DEFAULT_K) || GRAPH_DEFAULT_K, 1), 10);
  const min = Math.min(Math.max(Number.isFinite(opts.min) ? (opts.min as number) : GRAPH_DEFAULT_MIN, 0), 1);
  const items = input.slice(0, Math.min(opts.cap ?? GRAPH_MAX_NODES, GRAPH_MAX_NODES));
  const ids = items.map((m) => m.id);
  const known = new Set(ids);
  const dim = items[0]?.vector?.length ?? 0;
  const semantic = items.length > 1 && dim > 0 && items.every((m) => m.vector && m.vector.length === dim);
  let sim: (i: number, j: number) => number;
  let threshold = min;
  if (semantic) sim = (i, j) => cosine(items[i].vector!, items[j].vector!);
  else {
    const vecs = tfidfVectors(items.map((m) => tokenizeText(m.title + " " + m.text)));
    sim = (i, j) => sparseDot(vecs[i], vecs[j]);
    threshold = min * 0.6;
  }
  const edges: GraphEdge[] = [];
  for (const m of items) if (m.supersededBy && known.has(m.supersededBy) && m.supersededBy !== m.id) edges.push({ source: m.id, target: m.supersededBy, weight: 1, kind: "supersedes" });
  edges.push(...topKEdges(items.length, sim, k, threshold, ids, semantic ? "semantic" : "keyword"));
  return { nodes: ids.map((id) => ({ id })), edges, mode: semantic ? "semantic" : "keyword" };
}
