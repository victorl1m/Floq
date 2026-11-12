// Test harness: renders the real MemoryDialog against an in-memory fake runtime client (Playwright only; not part of the app bundle).
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import MemoryDialog from "@/components/canvas/memory-dialog";
import { Toaster } from "@/components/ui/sonner";
import { buildGraph } from "@/lib/memory-graph";
import { RuntimeError } from "@/lib/runtime/client";
import type { Memory, MemoryEvent } from "@/lib/runtime/types";
import { makeMemories } from "./fixture";

const params = new URLSearchParams(location.search);
const n = Number(params.get("n") ?? 60);
const graphMode = params.get("graph") ?? "ok"; // ok | 404
const disabled = params.get("disabled") === "1";
const empty = params.get("empty") === "1";
const slow = params.get("slow") === "1";
const badDates = params.get("dates") === "bad";
const store: Memory[] = empty ? [] : makeMemories(n);
// ?dates=bad: the shapes that used to render "Invalid Date": epoch seconds, numeric strings, the epoch placeholder, garbage, null.
if (badDates && store.length > 5) {
  const at = (v: unknown) => v as string;
  store[0].updatedAt = at(Math.floor(Date.now() / 1000) - 300); store[0].createdAt = at(String(Date.now() - 86_400_000));
  store[1].updatedAt = at("garbage"); store[1].createdAt = at(null);
  store[2].updatedAt = "1970-01-01T00:00:00.000Z"; store[2].createdAt = at(undefined);
  store[5].updatedAt = at(""); store[5].createdAt = at(0);
}
const calls: Array<{ name: string; args: unknown }> = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;
const events = new Map<string, MemoryEvent[]>();
const log = (id: string, action: MemoryEvent["action"]) => { const l = events.get(id) ?? []; l.push({ id: l.length + 1, memoryId: id, sessionId: null, actor: "user", action, before: null, after: null, createdAt: new Date().toISOString() }); events.set(id, l); };
const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unavailable = () => new RuntimeError(503, "memory_disabled", "Memory is disabled");

const client = {
  async projectMemories(_p: string, o: { q?: string; includeInvalid?: boolean } = {}) {
    calls.push({ name: "projectMemories", args: o });
    await sleep(slow ? 900 : 15);
    if (disabled) throw unavailable();
    let list = store.filter((m) => o.includeInvalid || !m.invalidatedAt);
    if (o.q) {
      const qs = tok(o.q);
      list = list.map((m) => ({ m, s: qs.filter((t) => tok(m.title + " " + m.text).includes(t)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => ({ ...x.m, score: x.s / qs.length }));
    }
    return { memories: list.map((m) => ({ ...m })), mode: "hybrid" };
  },
  async projectMemoryGraph(_p: string, o: { includeInvalid?: boolean; k?: number; min?: number } = {}) {
    calls.push({ name: "projectMemoryGraph", args: o });
    if (graphMode === "404") throw new RuntimeError(404, "not_found", "Not found");
    const list = store.filter((m) => o.includeInvalid || !m.invalidatedAt);
    return buildGraph(list.map((m) => ({ id: m.id, title: m.title, text: m.text, supersededBy: m.supersededBy })), { k: o.k, min: o.min });
  },
  async memoryStatus() { return { enabled: true, redis: true, backend: "dragonfly", embeddings: "local", model: "test", ready: true, vectors: true }; },
  async memoryEvents(id: string) {
    // The runtime's real event shape: `at` (no id, no createdAt). ?dates=bad adds a broken entry too.
    const base = [{ sessionId: null, actor: "agent", action: "add", before: null, after: null, at: "2026-11-01T10:00:00Z" }, ...(badDates ? [{ sessionId: null, actor: "user", action: "pin", before: null, after: null, at: "nope" }] : [])] as unknown as MemoryEvent[];
    return [...base, ...(events.get(id) ?? [])];
  },
  async updateMemory(id: string, patch: Record<string, unknown>) {
    calls.push({ name: "updateMemory", args: { id, patch } });
    const m = store.find((x) => x.id === id)!;
    if ("pinned" in patch) { m.pinned = !!patch.pinned; log(id, patch.pinned ? "pin" : "unpin"); }
    if (patch.invalidated === true) { m.invalidatedAt = new Date().toISOString(); m.invalidReason = (patch.reason as string) || "Invalidated by user"; log(id, "invalidate"); }
    if (patch.invalidated === false) { m.invalidatedAt = null; m.invalidReason = null; }
    for (const k of ["title", "text", "type"] as const) if (k in patch) (m as unknown as Record<string, unknown>)[k] = patch[k];
    m.updatedAt = new Date().toISOString();
    return { ...m };
  },
  async createMemory(_p: string, input: Record<string, unknown>) {
    calls.push({ name: "createMemory", args: input });
    const id = `new${store.length}`;
    const now = new Date().toISOString();
    store.push({ id, projectId: "p1", scope: (input.scope as Memory["scope"]) ?? "project", type: (input.type as Memory["type"]) ?? "fact", title: (input.title as string) ?? "", text: input.text as string, pinned: !!input.pinned, author: null, authorSession: null, createdAt: now, updatedAt: now, invalidatedAt: null, supersededBy: null, invalidReason: null });
    return { id, action: "added" };
  },
  async deleteMemory(id: string) { calls.push({ name: "deleteMemory", args: { id } }); store.splice(store.findIndex((m) => m.id === id), 1); },
};

// The test Chromium rejects the stylesheet's `woff2-variations` format hint and has no system fonts, so text would be invisible: register Geist through the FontFace API.
const geist = new FontFace("Geist Variable", "url(/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2)", { weight: "100 900" });
document.fonts.add(geist);
const geistMono = new FontFace("Geist Mono Variable", "url(/node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2)", { weight: "100 900" });
document.fonts.add(geistMono);
await Promise.all([geist.load(), geistMono.load()].map((p) => p.catch(() => undefined)));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryDialog projectId="p1" projectName="Floq" client={client as never} onClose={() => { document.title = "closed"; }} />
    <Toaster />
  </React.StrictMode>,
);
