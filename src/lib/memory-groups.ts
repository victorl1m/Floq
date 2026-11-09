/**
 * Pure grouping for the Memory graph: group memories by type / author / topic, expand or collapse groups, and fold the
 * similarity + supersedes edges into one edge per pair of displayed nodes. No React, no DOM; the API payload is unchanged
 * (groups are derived from the memories and the edges the runtime already returns).
 */
import type { MemoryType } from "./runtime/types.ts";
import { tokenizeText } from "./memory-graph.ts";

export type GroupMode = "none" | "type" | "topic" | "author";
export interface GMem { id: string; type: MemoryType; title: string; text: string; author: string | null }
export interface GEdge { source: string; target: string; weight: number; kind: "semantic" | "keyword" | "supersedes" }
/** `color` is "type:<type>" or "tok:<n>" (n cycles over the four --mem-* tokens). */
export interface Group { key: string; label: string; members: string[]; color: string }

export const groupNodeId = (key: string): string => "g:" + key;
export const isGroupNodeId = (id: string): boolean => id.startsWith("g:");
export const TYPE_LABEL: Record<MemoryType, string> = { fact: "Facts", decision: "Decisions", procedure: "Procedures", episode: "Episodes" };
const TYPES: MemoryType[] = ["fact", "decision", "procedure", "episode"];

/** Deterministic label propagation over the similarity edges (ids visited in sorted order, ties -> smallest label). */
export function communities(ids: string[], edges: GEdge[], minWeight: number, rounds = 15): Map<string, string> {
  const adj = new Map<string, Array<[string, number]>>(ids.map((i) => [i, []]));
  for (const e of edges) if (e.kind !== "supersedes" && e.weight >= minWeight && adj.has(e.source) && adj.has(e.target)) { adj.get(e.source)!.push([e.target, e.weight]); adj.get(e.target)!.push([e.source, e.weight]); }
  const sorted = [...ids].sort();
  const label = new Map(sorted.map((i) => [i, i]));
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    for (const id of sorted) {
      const tally = new Map<string, number>();
      for (const [n, w] of adj.get(id)!) tally.set(label.get(n)!, (tally.get(label.get(n)!) ?? 0) + w);
      if (!tally.size) continue;
      let best = label.get(id)!, bw = tally.get(best) ?? 0;
      for (const [l, w] of [...tally].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (w > bw + 1e-9) { best = l; bw = w; }
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  return label;
}

function topicLabel(members: GMem[], df: Map<string, number>, total: number): string {
  const tf = new Map<string, number>();
  for (const m of members) { for (const t of tokenizeText(m.title)) tf.set(t, (tf.get(t) ?? 0) + 2); for (const t of tokenizeText(m.text)) tf.set(t, (tf.get(t) ?? 0) + 1); }
  const top = [...tf].map(([t, c]) => [t, c * Math.log(1 + total / (df.get(t) ?? 1))] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map((x) => x[0]);
  return top.length ? top.map((t) => t[0].toUpperCase() + t.slice(1)).join(" · ") : "Topic";
}

export function groupMemories(mems: GMem[], edges: GEdge[], mode: GroupMode, opts: { minWeight?: number; maxTopics?: number } = {}): Group[] {
  if (mode === "none" || mems.length === 0) return [];
  if (mode === "type") {
    return TYPES.flatMap((t) => { const m = mems.filter((x) => x.type === t).map((x) => x.id); return m.length ? [{ key: "type:" + t, label: TYPE_LABEL[t], members: m, color: "type:" + t }] : []; });
  }
  if (mode === "author") {
    const by = new Map<string, string[]>();
    for (const m of mems) { const k = m.author ?? "you"; (by.get(k) ?? by.set(k, []).get(k)!).push(m.id); }
    return [...by].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).map(([k, m], i) => ({ key: "author:" + k, label: k === "you" ? "You" : k, members: m, color: "tok:" + (i % 4) }));
  }
  // topic
  const lab = communities(mems.map((m) => m.id), edges, opts.minWeight ?? 0.12);
  const byLabel = new Map<string, string[]>();
  for (const m of mems) { const l = lab.get(m.id)!; (byLabel.get(l) ?? byLabel.set(l, []).get(l)!).push(m.id); }
  const ranked = [...byLabel.values()].sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  const maxTopics = opts.maxTopics ?? 12;
  const keep = ranked.filter((g, i) => g.length >= 2 && i < maxTopics - 1);
  const rest = ranked.filter((g) => !keep.includes(g)).flat();
  if (rest.length) keep.push(rest);
  const byId = new Map(mems.map((m) => [m.id, m]));
  const df = new Map<string, number>();
  for (const m of mems) for (const t of new Set([...tokenizeText(m.title), ...tokenizeText(m.text)])) df.set(t, (df.get(t) ?? 0) + 1);
  return keep.map((ids, i) => ({ key: "topic:" + i, label: rest.length && ids === rest ? "Other" : topicLabel(ids.map((x) => byId.get(x)!), df, mems.length), members: ids, color: "tok:" + (i % 4) }));
}

export interface DNode { id: string; kind: "memory" | "group"; memoryId?: string; groupKey?: string; count: number; /** display nodes this one grows out of (position continuity on expand / collapse) */ seedFrom: string[] }
export interface DEdge { source: string; target: string; weight: number; count: number; kind: GEdge["kind"]; aggregated: boolean }
export interface Display { nodes: DNode[]; edges: DEdge[]; groupOf: Map<string, string>; hulls: Array<{ key: string; label: string; color: string; members: string[] }> }

/** Displayed nodes (group bubbles for collapsed groups, member nodes for expanded ones) and one edge per node pair and kind. */
export function buildDisplay(mems: GMem[], groups: Group[], expanded: ReadonlySet<string>, edges: GEdge[]): Display {
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const m of g.members) groupOf.set(m, g.key);
  if (!groups.length) return { nodes: mems.map((m) => ({ id: m.id, kind: "memory" as const, memoryId: m.id, count: 1, seedFrom: [] })), edges: edges.map((e) => ({ ...e, count: 1, aggregated: false })), groupOf, hulls: [] };
  const nodes: DNode[] = [], hulls: Display["hulls"] = [];
  const open = new Set(groups.filter((g) => expanded.has(g.key)).map((g) => g.key));
  for (const g of groups) {
    if (open.has(g.key)) { for (const m of g.members) nodes.push({ id: m, kind: "memory", memoryId: m, count: 1, seedFrom: [groupNodeId(g.key)] }); hulls.push({ key: g.key, label: g.label, color: g.color, members: g.members }); }
    else nodes.push({ id: groupNodeId(g.key), kind: "group", groupKey: g.key, count: g.members.length, seedFrom: g.members });
  }
  const disp = (id: string): string | null => { const k = groupOf.get(id); return k === undefined ? null : open.has(k) ? id : groupNodeId(k); };
  const agg = new Map<string, DEdge & { sum: number }>();
  for (const e of edges) {
    const a = disp(e.source), b = disp(e.target);
    if (!a || !b || a === b) continue;
    const sup = e.kind === "supersedes";
    const key = (sup ? "s|" + a + "|" + b : "q|" + (a < b ? a + "|" + b : b + "|" + a));
    const hit = agg.get(key);
    if (hit) { hit.count++; hit.sum += e.weight; } else agg.set(key, { source: a, target: b, weight: e.weight, count: 1, kind: e.kind, aggregated: false, sum: e.weight });
  }
  const out = [...agg.values()].map(({ sum, ...e }) => ({ ...e, aggregated: e.count > 1 || isGroupNodeId(e.source) || isGroupNodeId(e.target), weight: sup(e) ? 1 : Math.round((sum / e.count) * 1000) / 1000 }));
  return { nodes, edges: out, groupOf, hulls };
}
const sup = (e: { kind: GEdge["kind"] }) => e.kind === "supersedes";

/** Display node id of a memory (its group's bubble while the group is collapsed). */
export function displayIdOf(memoryId: string, groupOf: Map<string, string>, expanded: ReadonlySet<string>): string {
  const k = groupOf.get(memoryId);
  return k === undefined || expanded.has(k) ? memoryId : groupNodeId(k);
}

/** Lit display nodes with their match counts (a group counts its matching members). */
export function litNodes(matches: ReadonlySet<string>, groupOf: Map<string, string>, expanded: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of matches) { const d = displayIdOf(id, groupOf, expanded); out.set(d, (out.get(d) ?? 0) + 1); }
  return out;
}

/** Groups holding a match are opened automatically while only a few memories match (the search stays readable). */
export function autoExpand(groups: Group[], matches: ReadonlySet<string> | null, limit = 8): Set<string> {
  const out = new Set<string>();
  if (!matches || matches.size === 0 || matches.size > limit) return out;
  for (const g of groups) if (g.members.some((m) => matches.has(m))) out.add(g.key);
  return out;
}

/** Bubble radius by member count. */
export const groupRadius = (count: number): number => Math.min(16 + 5 * Math.sqrt(count), 62);
