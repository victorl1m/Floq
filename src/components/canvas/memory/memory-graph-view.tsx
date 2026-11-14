import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconArrowsMaximize, IconArrowsMinimize, IconMinus, IconPlus, IconRefresh, IconScan } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { loadCanvasScroll } from "@/lib/canvas-scroll-pref";
import { newWheelState, pinchFactor, wheelAction, wheelPixels } from "@/lib/wheel-gesture";
import { fitTransform, ForceSim, pickNode, placeLabels, type ForceLink, type PlacedLabel, type Point } from "@/lib/memory-force";
import { autoExpand, buildDisplay, displayIdOf, groupMemories, groupRadius, litNodes, type GEdge, type GroupMode } from "@/lib/memory-groups";
import type { Memory, MemoryGraph, MemoryType } from "@/lib/runtime/types";
import { MEMORY_TYPES, titleOf, truncate, TYPE_META, typeColor } from "./memory-meta";

/* =====================================================================================================================
   Floq memory graph on a <canvas>: soft discs in the Floq palette on the canvas dot grid, thin curved links.
   - One DPR-aware canvas, drawn by a plain class (GraphEngine): React never re-renders per tick, hover or drag.
   - Continuous, damped force simulation (ForceSim): repulsion, springs by similarity, centre gravity, collision. It cools
     down by itself, wakes up on drag / new data and stops drawing when idle.
   - Pan (drag), zoom (wheel, buttons, pinch), node drag, neighbour fade + coloured links + glow on hover/selection,
     greedy collision-aware label placement (the hovered / selected label sits in a pill).
   - Colours come from the app's CSS variables (light/dark), re-read on theme change.
   - prefers-reduced-motion: the layout is solved synchronously, nothing eases or animates (static mode).
   - Grouped mode (Type / Topic / Author): a group is one bubble (name + count). Click expands it in place (its members
     replace the bubble and start from its position, one re-seeded simulation), the hull chip collapses it, double click
     focuses it. Member links fold into one edge per pair of displayed nodes (thickness by link count, count on hover).
   `canvas.__memgraph` exposes read-only state for tests/tooling (node screen positions, labels, frame stats).
   ===================================================================================================================== */

/** `color` is "type:<type>" or "tok:<n>" (n cycles over the four --mem-* tokens); `seedFrom` = previous display nodes this one grows out of. */
interface NodeInfo { id: string; r: number; pinned: boolean; forgotten: boolean; color: string; title: string; label: string; count: number; group: boolean; groupKey: string | null; /** expanded group this memory belongs to */ hull: string | null; charge: number; seedFrom: string[] }
interface EdgeIn { source: string; target: string; /** 0..1 drawing strength */ strength: number; kind: "semantic" | "keyword" | "supersedes"; count: number }
interface HullIn { key: string; label: string; color: string; members: string[] }
interface Callbacks { onSelect: (id: string) => void; onLayout: (ms: number) => void; onToggleGroup: (key: string) => void; onFocusGroup: (key: string) => void }
/** `bg` = stage colour (label halos, node cut-out rims), `dot` = canvas grid dots, `edge` = resting link colour, `card` / `border` = label pills and hull chips. */
interface Colors { types: Record<MemoryType, string>; muted: string; accent: string; fg: string; bg: string; dot: string; edge: string; card: string; border: string; font: string }
interface View { k: number; tx: number; ty: number }

const BUCKETS = 4;
const GRID = 24; // world units between grid dots (the agent canvas uses 22 px)
const BEND = 0.14; // edge curvature: control point offset as a share of the edge length
const TAU = Math.PI * 2;
const MIN_ZOOM = 0.08, MAX_ZOOM = 6;
const DIM = 0.14; // alpha of faded nodes
const ease = 0.22;

class GraphEngine {
  private ctx: CanvasRenderingContext2D;
  private sim: ForceSim | null = null;
  private infos: NodeInfo[] = [];
  private key = "";
  private edges: Array<{ a: number; b: number; s: number; sup: boolean; count: number }> = [];
  private hulls: Array<HullIn & { idx: number[] }> = [];
  private chips: Array<{ key: string; x0: number; y0: number; x1: number; y1: number }> = [];
  private hoverEdge = -1;
  private litCount = new Map<number, number>();
  private fitSubset: number[] | null = null;
  private pending: { key: string; timer: number } | null = null;
  private nbrs: number[][] = [];
  private cur = new Float32Array(0);
  private tgt = new Float32Array(0);
  private eBright = new Uint8Array(0);
  private dimMix = 0;
  private dimTarget = 0;
  private hover = -1;
  private selected = -1;
  private matches: Set<number> | null = null;
  private view: View = { k: 1, tx: 0, ty: 0 };
  private viewT: View = { k: 1, tx: 0, ty: 0 };
  private autoFit = true;
  private w = 800;
  private h = 500;
  private dpr = 1;
  private raf = 0;
  private reduced = false;
  private colors: Colors;
  private placed: PlacedLabel[] = [];
  private labelKey = "";
  private labelAt = 0;
  private labelCount = 0;
  private widthCache = new Map<string, number>();
  private samples: number[] = [];
  private drag: { i: number; moved: boolean; sx: number; sy: number } | null = null;
  private pan: { x: number; y: number; moved: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; k: number; wx: number; wy: number } | null = null;
  private lastClick = { id: "", t: 0 };
  private disposers: Array<() => void> = [];
  private seedUsed = 1;
  private infos_prev: NodeInfo[] = [];

  constructor(private canvas: HTMLCanvasElement, private wrap: HTMLElement, private tip: HTMLElement, private cb: Callbacks) {
    this.ctx = canvas.getContext("2d")!;
    this.colors = this.readColors();
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.reduced = !!mq?.matches;
    const onMq = () => { this.reduced = !!mq?.matches; };
    mq?.addEventListener?.("change", onMq);
    this.disposers.push(() => mq?.removeEventListener?.("change", onMq));

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(wrap);
    this.disposers.push(() => ro.disconnect());
    this.resize(true);

    // Theme: class/data-theme flips on <html> and the OS scheme both change the CSS variables.
    const mo = new MutationObserver(() => { this.colors = this.readColors(); this.request(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-material"] });
    this.disposers.push(() => mo.disconnect());
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onDark = () => { this.colors = this.readColors(); this.request(); };
    dark?.addEventListener?.("change", onDark);
    this.disposers.push(() => dark?.removeEventListener?.("change", onDark));

    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      canvas.addEventListener(t, f as EventListener, o);
      this.disposers.push(() => canvas.removeEventListener(t, f as EventListener));
    };
    on("pointerdown", (e) => this.onDown(e));
    on("pointermove", (e) => this.onMove(e));
    on("pointerup", (e) => this.onUp(e));
    on("pointercancel", (e) => this.onUp(e));
    on("pointerleave", () => { if (!this.drag && !this.pan && this.pointers.size === 0) this.setHover(-1); });
    on("wheel", (e) => this.onWheel(e), { passive: false });
    on("keydown", (e) => this.onKey(e));

    (canvas as unknown as { __memgraph: unknown }).__memgraph = this.api();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.disposers.forEach((d) => d());
    this.disposers = [];
    delete (this.canvas as unknown as { __memgraph?: unknown }).__memgraph;
  }

  /* ---------- data ---------- */

  setGraph(infos: NodeInfo[], links: ForceLink[], seed: number, hulls: HullIn[] = []): number {
    const infosPrev = this.infos;
    this.infos = infos;
    this.infos_prev = infosPrev;
    const key = seed + "|" + infos.map((n) => n.id).join(",") + "|" + links.map((l) => l.source + ">" + l.target).join(",");
    this.hulls = hulls.map((h) => ({ ...h, idx: [] }));
    if (key === this.key && this.sim) {
      infos.forEach((n, i) => this.sim!.setRadius(i, n.r));
      this.indexHulls();
      this.request();
      return -1;
    }
    // Continuity: nodes that exist in the old picture stay where they are; a new node starts at the mean of the old nodes it grows out of.
    const old = this.sim ? this.sim.positions() : null;
    const oldR = new Map<string, number>(this.sim ? this.infos_prev.map((n) => [n.id, n.r]) : []);
    const initial = new Map<string, Point & { spread?: number }>();
    if (old) for (const n of infos) {
      let p: (Point & { spread?: number }) | undefined = old.get(n.id);
      if (!p) {
        const from = n.seedFrom.filter((id) => old.has(id));
        if (from.length) {
          const pts = from.map((id) => old.get(id)!);
          p = { x: pts.reduce((t, q) => t + q.x, 0) / pts.length, y: pts.reduce((t, q) => t + q.y, 0) / pts.length };
          // a member leaving its bubble starts spread over the bubble's disc; a bubble forming from members starts at their centroid
          if (from.length === 1) p.spread = (oldR.get(from[0]) ?? n.r) * 0.85;
        }
      }
      if (p) initial.set(n.id, p);
    }
    const continuity = initial.size > 0 && this.seedUsed === seed;
    this.key = key; this.seedUsed = seed;
    const t0 = performance.now();
    this.sim = new ForceSim(infos.map((n) => ({ id: n.id, pinned: n.pinned, r: n.r, charge: n.charge, group: n.hull })), links, { seed, aspect: this.w / Math.max(this.h, 1), initial: continuity ? initial : undefined });
    if (continuity) { this.sim.alpha = 0.4; if (this.reduced) this.sim.run(600); } else this.sim.run(this.reduced ? 600 : 110); // static mode: solved now; otherwise the rest settles visibly
    const ms = Math.round(performance.now() - t0);
    this.cur = new Float32Array(infos.length).fill(1); this.tgt = new Float32Array(infos.length).fill(1);
    this.hover = -1; this.hoverEdge = -1; this.selected = -1; this.matches = null; this.litCount = new Map();
    this.indexHulls();
    this.placed = []; this.labelKey = "";
    if (!continuity) { this.fitSubset = null; this.autoFit = true; this.fit(false); }
    else if (this.autoFit) { this.viewT = this.fitView(); if (this.reduced) this.view = { ...this.viewT }; }
    this.cb.onLayout(ms);
    this.request();
    return ms;
  }

  private indexHulls(): void { const s = this.sim; for (const h of this.hulls) h.idx = s ? h.members.map((id) => s.indexOf(id)).filter((i) => i >= 0) : []; }

  /** Zoom the camera on one expanded group and keep following it while the layout settles. */
  focusGroup(key: string): void {
    const h = this.hulls.find((x) => x.key === key);
    if (!h || h.idx.length === 0) return;
    this.fitSubset = h.idx; this.autoFit = true;
    this.viewT = this.fitView();
    if (this.reduced) this.view = { ...this.viewT };
    this.request();
  }

  setEdges(list: EdgeIn[]): void {
    const sim = this.sim;
    this.edges = [];
    this.nbrs = this.infos.map(() => []);
    if (sim) for (const e of list) {
      const a = sim.indexOf(e.source), b = sim.indexOf(e.target);
      if (a < 0 || b < 0) continue;
      this.edges.push({ a, b, s: e.strength, sup: e.kind === "supersedes", count: e.count });
      this.nbrs[a].push(b); this.nbrs[b].push(a);
    }
    this.eBright = new Uint8Array(this.edges.length).fill(1);
    this.hoverEdge = -1;
    this.retarget();
    this.request();
  }

  /** `lit`: display node id -> match count (a group counts its matching members); null = nothing to highlight. */
  setHighlight(lit: Map<string, number> | null, selectedId: string | null): void {
    const sim = this.sim;
    this.selected = sim && selectedId ? sim.indexOf(selectedId) : -1;
    this.litCount = new Map();
    if (lit && sim) { const set = new Set<number>(); for (const [id, n] of lit) { const i = sim.indexOf(id); if (i >= 0) { set.add(i); this.litCount.set(i, n); } } this.matches = set; } else this.matches = null;
    this.retarget();
    this.labelKey = "";
    this.request();
  }

  /* ---------- view ---------- */

  fit(animate = true): void {
    this.autoFit = true;
    this.fitSubset = null;
    this.viewT = this.fitView();
    if (!animate || this.reduced) this.view = { ...this.viewT };
    this.request();
  }

  zoomBy(f: number): void {
    this.autoFit = false;
    const v = this.viewT, k = Math.min(Math.max(v.k * f, MIN_ZOOM), MAX_ZOOM);
    this.viewT = { k, tx: this.w / 2 - ((this.w / 2 - v.tx) / v.k) * k, ty: this.h / 2 - ((this.h / 2 - v.ty) / v.k) * k };
    if (this.reduced) this.view = { ...this.viewT };
    this.request();
  }

  centerOn(i: number): void {
    const sim = this.sim;
    if (!sim || i < 0) return;
    this.autoFit = false;
    const k = Math.max(this.view.k, 1.1);
    this.viewT = { k, tx: this.w / 2 - sim.x[i] * k, ty: this.h / 2 - sim.y[i] * k };
    if (this.reduced) this.view = { ...this.viewT };
    this.request();
  }

  private fitView(): View {
    const sim = this.sim;
    if (!sim || sim.n === 0) return { k: 1, tx: this.w / 2, ty: this.h / 2 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const pick = this.fitSubset && this.fitSubset.length ? this.fitSubset : null;
    for (let q = 0; q < (pick ? pick.length : sim.n); q++) { const i = pick ? pick[q] : q; const r = sim.r[i] + 6; x0 = Math.min(x0, sim.x[i] - r); x1 = Math.max(x1, sim.x[i] + r); y0 = Math.min(y0, sim.y[i] - r); y1 = Math.max(y1, sim.y[i] + r); }
    const grouped = this.infos.some((n) => n.group);
    // the legend chip covers the bottom strip of the canvas: fit into the rest; bubbles are not magnified beyond 2x
    return fitTransform({ minX: x0, minY: y0, maxX: x1, maxY: y1 }, this.w, this.h - 36, { pad: 0.045, maxK: pick ? 3 : grouped ? 2 : 3 });
  }

  private resize(initial = false): void {
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const dw = r.width - this.w, dh = r.height - this.h;
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    if (!initial && this.sim) {
      if (this.autoFit) this.fit(false);
      else { this.view.tx += dw / 2; this.view.ty += dh / 2; this.viewT.tx += dw / 2; this.viewT.ty += dh / 2; }
    }
    this.labelKey = "";
    this.request();
  }

  /* ---------- interaction ---------- */

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private world(x: number, y: number): { x: number; y: number } { return { x: (x - this.view.tx) / this.view.k, y: (y - this.view.ty) / this.view.k }; }
  private hit(x: number, y: number): number { const s = this.sim; return s ? pickNode(s.x, s.y, s.r, this.view, x, y, 3) : -1; }
  private userMoved(): void { this.autoFit = false; this.viewT = { ...this.view }; }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic or already released pointer */ }
    this.canvas.focus({ preventScroll: true });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, w = this.world(mid.x, mid.y);
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.view.k, wx: w.x, wy: w.y };
      this.drag = null; this.pan = null; this.endDragSim();
      return;
    }
    const chip = this.chips.find((c) => p.x >= c.x0 && p.x <= c.x1 && p.y >= c.y0 && p.y <= c.y1);
    if (chip) { this.cb.onToggleGroup(chip.key); return; }
    const i = this.hit(p.x, p.y);
    if (i >= 0) this.drag = { i, moved: false, sx: p.x, sy: p.y };
    else this.pan = { x: p.x, y: p.y, moved: false };
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = Math.min(Math.max(this.pinch.k * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / this.pinch.d), MIN_ZOOM), MAX_ZOOM);
      this.view = { k, tx: mid.x - this.pinch.wx * k, ty: mid.y - this.pinch.wy * k };
      this.userMoved(); this.request();
      return;
    }
    if (this.drag) {
      const d = this.drag, sim = this.sim!;
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 4) return;
      if (!d.moved) { d.moved = true; this.userMoved(); this.setHover(-1); if (!this.reduced) { sim.alphaTarget = 0.3; sim.reheat(0.3); } }
      const w = this.world(p.x, p.y);
      sim.fx[d.i] = w.x; sim.fy[d.i] = w.y;
      if (this.reduced) { sim.x[d.i] = w.x; sim.y[d.i] = w.y; }
      this.request();
      return;
    }
    if (this.pan) {
      const d = this.pan, dx = p.x - d.x, dy = p.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true; d.x = p.x; d.y = p.y;
      this.view.tx += dx; this.view.ty += dy;
      this.userMoved(); this.request();
      return;
    }
    if (e.pointerType !== "touch") { const i = this.hit(p.x, p.y); this.setHover(i, p, i < 0 ? this.pickEdge(p.x, p.y) : -1); }
  }

  /** Nearest edge within 6 px of the pointer (screen space), or -1. Only used when no node is under the pointer. */
  private pickEdge(px: number, py: number): number {
    const s = this.sim, k = this.view.k;
    if (!s) return -1;
    let best = -1, bd = 6;
    // The edges are gentle quadratic curves: test the pointer against 8 chords of each curve (screen space).
    const tx = this.view.tx, ty = this.view.ty;
    for (let i = 0; i < this.edges.length; i++) {
      const c = this.curve(this.edges[i]);
      const x0 = c[0] * k + tx, y0 = c[1] * k + ty, cx = c[2] * k + tx, cy = c[3] * k + ty, x1 = c[4] * k + tx, y1 = c[5] * k + ty;
      if (px < Math.min(x0, cx, x1) - bd || px > Math.max(x0, cx, x1) + bd || py < Math.min(y0, cy, y1) - bd || py > Math.max(y0, cy, y1) + bd) continue;
      let ax = x0, ay = y0;
      for (let q = 1; q <= 8; q++) {
        const t = q / 8, u = 1 - t, bx = u * u * x0 + 2 * u * t * cx + t * t * x1, by = u * u * y0 + 2 * u * t * cy + t * t * y1;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const h = Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / l2, 0), 1);
        const d = Math.hypot(px - (ax + h * dx), py - (ay + h * dy));
        if (d < bd) { bd = d; best = i; }
        ax = bx; ay = by;
      }
    }
    return best;
  }

  private onUp(e: PointerEvent): void {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const d = this.drag;
    if (d) {
      this.endDragSim();
      this.drag = null;
      if (!d.moved) {
        const info = this.infos[d.i];
        if (info?.group && info.groupKey) {
          // single click expands / collapses (after a short wait), double click focuses the group instead
          const key = info.groupKey;
          if (this.pending && this.pending.key === key) { window.clearTimeout(this.pending.timer); this.pending = null; this.cb.onFocusGroup(key); }
          else this.pending = { key, timer: window.setTimeout(() => { this.pending = null; this.cb.onToggleGroup(key); }, this.reduced ? 0 : 260) };
        } else if (info) {
          const now = performance.now();
          this.cb.onSelect(info.id);
          if (this.lastClick.id === info.id && now - this.lastClick.t < 350) this.centerOn(d.i);
          this.lastClick = { id: info.id, t: now };
        }
      }
      return;
    }
    this.pan = null;
    if (e.pointerType === "touch") this.setHover(-1); else { const i = this.hit(p.x, p.y); this.setHover(i, p, i < 0 ? this.pickEdge(p.x, p.y) : -1); }
  }

  private endDragSim(): void {
    const s = this.sim, d = this.drag;
    if (!s || !d) return;
    s.fx[d.i] = NaN; s.fy[d.i] = NaN; s.alphaTarget = 0;
    this.request();
  }

  private wheelState = newWheelState();

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e), v = this.view;
    const action = wheelAction(e, loadCanvasScroll(), this.wheelState, e.timeStamp || performance.now());
    if (action === "pan") {
      const d = wheelPixels(e, this.h);
      v.tx -= e.shiftKey && d.x === 0 ? d.y : d.x; v.ty -= e.shiftKey && d.x === 0 ? 0 : d.y;
      this.userMoved(); this.request();
      return;
    }
    const k = Math.min(Math.max(v.k * (action === "pinch" ? pinchFactor(e.deltaY, e.deltaMode) : Math.exp(-e.deltaY * 0.0015)), MIN_ZOOM), MAX_ZOOM);
    v.tx = p.x - ((p.x - v.tx) / v.k) * k; v.ty = p.y - ((p.y - v.ty) / v.k) * k; v.k = k;
    this.userMoved(); this.request();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); this.zoomBy(1.3); }
    else if (e.key === "-") { e.preventDefault(); this.zoomBy(1 / 1.3); }
    else if (e.key === "0") { e.preventDefault(); this.fit(true); }
    else if (e.key === "Enter" && this.hover >= 0) { const n = this.infos[this.hover]; if (n.group && n.groupKey) this.cb.onToggleGroup(n.groupKey); else this.cb.onSelect(n.id); }
  }

  private setHover(i: number, p?: { x: number; y: number }, edge = -1): void {
    const tip = this.tip;
    let text = "";
    if (i >= 0) text = this.infos[i].title;
    else if (edge >= 0) { const e = this.edges[edge]; text = e.sup ? `${this.infos[e.a].label} superseded by ${this.infos[e.b].label}${e.count > 1 ? ` (${e.count} links)` : ""}` : `${e.count} ${e.count === 1 ? "link" : "links"}: ${this.infos[e.a].label} ↔ ${this.infos[e.b].label}`; }
    if (text && p) {
      tip.textContent = text;
      tip.style.display = "block";
      tip.style.left = `${Math.min(p.x + 12, this.w - 260)}px`;
      tip.style.top = `${Math.max(p.y - 34, 4)}px`;
    } else if (!text) tip.style.display = "none";
    const overChip = !!p && this.chips.some((c) => p.x >= c.x0 && p.x <= c.x1 && p.y >= c.y0 && p.y <= c.y1);
    this.canvas.style.cursor = i >= 0 || overChip ? "pointer" : edge >= 0 ? "help" : this.pan ? "grabbing" : "grab";
    if (i === this.hover && edge === this.hoverEdge) return;
    this.hover = i; this.hoverEdge = edge;
    this.retarget();
    this.labelKey = "";
    this.request();
  }

  /* ---------- animation ---------- */

  private retarget(): void {
    const n = this.infos.length;
    if (this.tgt.length !== n) { this.tgt = new Float32Array(n).fill(1); this.cur = new Float32Array(n).fill(1); }
    const h = this.hover, m = this.matches, he = this.hoverEdge;
    if (h < 0 && he >= 0) {
      this.tgt.fill(DIM); this.tgt[this.edges[he].a] = 1; this.tgt[this.edges[he].b] = 1;
      this.dimTarget = 1;
      this.edges.forEach((_e, i) => { this.eBright[i] = i === he ? 1 : 0; });
    } else if (h >= 0) {
      this.tgt.fill(DIM); this.tgt[h] = 1;
      for (const j of this.nbrs[h] ?? []) this.tgt[j] = 1;
      this.dimTarget = 1;
      this.edges.forEach((e, i) => { this.eBright[i] = e.a === h || e.b === h ? 1 : 0; });
    } else if (m) {
      for (let i = 0; i < n; i++) this.tgt[i] = m.has(i) ? 1 : DIM;
      this.dimTarget = 1;
      this.edges.forEach((e, i) => { this.eBright[i] = m.has(e.a) && m.has(e.b) ? 1 : 0; });
    } else {
      this.tgt.fill(1); this.dimTarget = 0; this.eBright.fill(1);
    }
    if (this.reduced) { this.cur.set(this.tgt); this.dimMix = this.dimTarget; }
  }

  request(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(_t: number): void {
    this.raf = 0;
    const t0 = performance.now();
    const sim = this.sim;
    let busy = false;
    if (sim && !this.reduced && !sim.settled) { sim.tick(); busy = true; }
    // eased node fade and view
    const c = this.cur, g = this.tgt;
    for (let i = 0; i < c.length; i++) {
      const d = g[i] - c[i];
      if (Math.abs(d) > 0.008) { c[i] += d * 0.3; busy = true; } else c[i] = g[i];
    }
    const dm = this.dimTarget - this.dimMix;
    if (Math.abs(dm) > 0.008) { this.dimMix += dm * 0.3; busy = true; } else this.dimMix = this.dimTarget;
    if (this.autoFit && sim && !sim.settled) this.viewT = this.fitView();
    const v = this.view, vt = this.viewT;
    if (Math.abs(vt.k - v.k) > 0.0005 || Math.abs(vt.tx - v.tx) > 0.1 || Math.abs(vt.ty - v.ty) > 0.1) {
      if (this.reduced) this.view = { ...vt };
      else { v.k += (vt.k - v.k) * ease; v.tx += (vt.tx - v.tx) * ease; v.ty += (vt.ty - v.ty) * ease; busy = true; }
    } else if (v.k !== vt.k || v.tx !== vt.tx || v.ty !== vt.ty) this.view = { ...vt };
    if (this.drag?.moved && !this.reduced) busy = true;
    this.draw(t0, busy);
    this.syncAttrs();
    const ms = performance.now() - t0;
    this.samples.push(ms); if (this.samples.length > 400) this.samples.shift();
    if (busy) this.request();
  }

  /* ---------- drawing ---------- */

  private readColors(): Colors {
    const cs = getComputedStyle(this.canvas);
    // Theme variables only. A missing variable falls through to another theme variable and finally to currentColor (never a literal colour).
    const v = (...names: string[]) => { for (const n of names) { const x = cs.getPropertyValue(n).trim(); if (x) return x; } return "currentColor"; };
    return {
      types: { fact: v("--mem-fact", "--chart-2", "--foreground"), decision: v("--mem-decision", "--chart-3", "--foreground"), procedure: v("--mem-procedure", "--chart-4", "--foreground"), episode: v("--mem-episode", "--chart-5", "--foreground") },
      muted: v("--muted-foreground", "--foreground"), accent: v("--mem-link-supersedes", "--primary-text", "--primary", "--foreground"), fg: v("--foreground"),
      bg: v("--mem-stage", "--background", "--card"), dot: v("--mem-stage-dot", "--border", "--muted-foreground"), edge: v("--mem-link", "--muted-foreground", "--foreground"),
      card: v("--popover", "--card", "--background"), border: v("--border", "--muted-foreground"),
      font: cs.fontFamily || "sans-serif",
    };
  }

  private textW(text: string): number {
    let w = this.widthCache.get(text);
    if (w === undefined) { w = this.ctx.measureText(text).width; if (this.widthCache.size > 4000) this.widthCache.clear(); this.widthCache.set(text, w); }
    return w;
  }

  /** Canvas dot grid that pans and zooms with the graph, like the agent canvas behind this dialog. */
  private drawGrid(): void {
    const ctx = this.ctx, k = this.view.k;
    let step = GRID * k;
    while (step < 14) step *= 2;
    while (step > 56) step /= 2;
    const ox = ((this.view.tx % step) + step) % step, oy = ((this.view.ty % step) + step) % step;
    const s = Math.min(1.6, Math.max(1, k * 1.2));
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = this.colors.dot;
    ctx.beginPath();
    for (let y = oy; y < this.h; y += step) for (let x = ox; x < this.w; x += step) ctx.rect(x - s / 2, y - s / 2, s, s);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private draw(_t0: number, moving: boolean): void {
    const ctx = this.ctx, sim = this.sim, col = this.colors, k = this.view.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawGrid();
    if (!sim || sim.n === 0) return;
    ctx.save();
    ctx.translate(this.view.tx, this.view.ty);
    ctx.scale(k, k);
    ctx.lineCap = "round";
    const px = 1 / k; // one screen pixel in world units
    const lw = 1 / Math.max(k, 0.6); // line widths stop thinning out below 0.6x so far views stay legible

    // hulls of expanded groups: a faint tinted disc with a hairline rim behind the members
    this.chips = [];
    const hullGeo: Array<{ h: HullIn & { idx: number[] }; cx: number; cy: number; r: number }> = [];
    for (const h of this.hulls) {
      if (!h.idx.length) continue;
      let cx = 0, cy = 0;
      for (const i of h.idx) { cx += sim.x[i]; cy += sim.y[i]; }
      cx /= h.idx.length; cy /= h.idx.length;
      let r = 0;
      for (const i of h.idx) r = Math.max(r, Math.hypot(sim.x[i] - cx, sim.y[i] - cy) + sim.r[i]);
      r += 18;
      hullGeo.push({ h, cx, cy, r });
      const color = this.colorOf(h.color);
      ctx.fillStyle = color; ctx.strokeStyle = color;
      ctx.globalAlpha = 0.055; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.32; ctx.lineWidth = px; ctx.stroke();
    }

    // similarity edges: thin, muted, gently curved; one path per (weight bucket, bright|dim) instead of one stroke per edge
    const dim = 1 - 0.9 * this.dimMix;
    ctx.strokeStyle = col.edge;
    for (const bright of [0, 1]) {
      for (let b = 0; b < BUCKETS; b++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < this.edges.length; i++) {
          const e = this.edges[i];
          if (e.sup || this.eBright[i] !== bright || Math.min(BUCKETS - 1, Math.floor(Math.min(Math.max(e.s, 0), 0.9999) * BUCKETS)) !== b) continue;
          const c = this.curve(e); ctx.moveTo(c[0], c[1]); ctx.quadraticCurveTo(c[2], c[3], c[4], c[5]); any = true;
        }
        if (!any) continue;
        const f = b / (BUCKETS - 1);
        ctx.lineWidth = (0.75 + f * 1.25) * lw;
        ctx.globalAlpha = (0.22 + f * 0.36) * (bright ? 1 : dim);
        ctx.stroke();
      }
    }
    // focus edges (hovered node or edge, else the selected node): coloured from one endpoint to the other
    const focus = this.hover >= 0 || this.hoverEdge >= 0 ? (this.dimMix > 0.05 ? this.dimMix : 0) : this.selected >= 0 ? 0.75 : 0;
    if (focus > 0) {
      const sel = this.hover < 0 && this.hoverEdge < 0 ? this.selected : -1;
      ctx.lineWidth = 1.7 * lw;
      for (let i = 0; i < this.edges.length; i++) {
        const e = this.edges[i];
        if (e.sup) continue;
        if (sel >= 0 ? e.a !== sel && e.b !== sel : this.eBright[i] !== 1) continue;
        const c = this.curve(e), g = ctx.createLinearGradient(c[0], c[1], c[4], c[5]);
        g.addColorStop(0, this.colorOf(this.infos[e.a].color)); g.addColorStop(1, this.colorOf(this.infos[e.b].color));
        ctx.strokeStyle = g; ctx.globalAlpha = 0.85 * focus;
        ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.quadraticCurveTo(c[2], c[3], c[4], c[5]); ctx.stroke();
      }
    }
    // supersedes: dashed accent curve with a small arrow head at the newer memory
    ctx.strokeStyle = col.accent; ctx.fillStyle = col.accent;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (!e.sup) continue;
      const c = this.curve(e), tdx = c[4] - c[2], tdy = c[5] - c[3], d = Math.hypot(tdx, tdy) || 1, ux = tdx / d, uy = tdy / d;
      const back = this.infos[e.b].group ? 3 * px : sim.r[e.b] + 3 * px;
      const ex = c[4] - ux * back, ey = c[5] - uy * back, s = 6.5 * lw;
      ctx.globalAlpha = 0.9 * (this.eBright[i] ? 1 : dim);
      ctx.setLineDash([4 * lw, 3.5 * lw]); ctx.lineWidth = 1.5 * lw;
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.quadraticCurveTo(c[2], c[3], ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - ux * s - uy * s * 0.55, ey - uy * s + ux * s * 0.55); ctx.lineTo(ex - ux * s + uy * s * 0.55, ey - uy * s - ux * s * 0.55); ctx.closePath(); ctx.fill();
    }

    // nodes: soft discs with a cut-out rim in the stage colour; hovered / selected ones glow and draw last
    const minR = 3 * px;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < sim.n; i++) {
        const top = i === this.hover || i === this.selected;
        if ((pass === 1) !== top) continue;
        const n = this.infos[i], a = this.cur[i], r = Math.max(sim.r[i], minR), x = sim.x[i], y = sim.y[i], color = this.colorOf(n.color);
        if (top) {
          const glow = r + (n.group ? 10 : 14) * px, g = ctx.createRadialGradient(x, y, r * 0.6, x, y, glow);
          g.addColorStop(0, color); g.addColorStop(1, "transparent");
          ctx.globalAlpha = i === this.selected ? 0.5 : 0.36; ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(x, y, glow, 0, TAU); ctx.fill();
        }
        ctx.fillStyle = color; ctx.strokeStyle = color;
        if (n.pinned) { ctx.globalAlpha = 0.85 * a; ctx.lineWidth = 1.4 * px; ctx.beginPath(); ctx.arc(x, y, r + 3.5 * px, 0, TAU); ctx.stroke(); }
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
        if (n.group) {
          ctx.globalAlpha = 0.16 * a; ctx.fill();
          ctx.globalAlpha = 0.9 * a; ctx.lineWidth = 1.6 * px; ctx.stroke();
          ctx.globalAlpha = 0.35 * a; ctx.beginPath(); ctx.arc(x, y, Math.max(r - 5 * px, r * 0.82), 0, TAU); ctx.lineWidth = px; ctx.stroke();
        } else if (n.forgotten) {
          ctx.globalAlpha = 0.12 * a; ctx.fill();
          ctx.globalAlpha = 0.7 * a; ctx.lineWidth = 1.3 * px; ctx.setLineDash([2.5 * px, 2 * px]); ctx.stroke(); ctx.setLineDash([]);
        } else {
          ctx.globalAlpha = a; ctx.fill();
          ctx.strokeStyle = col.bg; ctx.lineWidth = 1.5 * px; ctx.stroke(); // cut-out rim keeps touching discs apart
          if (r * k >= 6) { ctx.globalAlpha = 0.28 * a; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = px; ctx.beginPath(); ctx.arc(x, y, r - 1.6 * px, Math.PI * 1.05, Math.PI * 1.75); ctx.stroke(); }
        }
        if (top) { ctx.globalAlpha = i === this.selected ? 1 : 0.7; ctx.strokeStyle = col.fg; ctx.lineWidth = (i === this.selected ? 2 : 1.4) * px; ctx.beginPath(); ctx.arc(x, y, r + (n.pinned ? 6 : 3) * px, 0, TAU); ctx.stroke(); }
      }
    }
    ctx.restore();

    // labels in screen space (constant size), collision-aware; the hovered / selected label sits in a pill
    ctx.globalAlpha = 1;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.lineJoin = "round";
    ctx.font = `500 11px ${col.font}`;
    this.layoutLabels(moving);
    const quiet = this.hover < 0 && this.hoverEdge < 0 && !this.matches;
    for (const l of this.placed) {
      const i = sim.indexOf(l.id);
      if (i < 0) continue;
      const sx = sim.x[i] * k + this.view.tx, sy = sim.y[i] * k + this.view.ty, r = Math.max(sim.r[i] * k, 3), text = this.labelOf(i), ly = sy + r + 13;
      const strong = i === this.hover || i === this.selected;
      if (strong) {
        ctx.font = `600 11px ${col.font}`;
        const w = this.textW(text) + 14;
        ctx.globalAlpha = 0.96; ctx.fillStyle = col.card; ctx.strokeStyle = col.border; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(sx - w / 2, ly - 12, w, 17, 8.5); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1; ctx.fillStyle = col.fg; ctx.fillText(text, sx, ly);
        ctx.font = `500 11px ${col.font}`;
        continue;
      }
      // resting labels are a step quieter than lit ones so the eye lands on the nodes first
      ctx.globalAlpha = Math.max(this.cur[i], 0.45) * (quiet && !this.infos[i].group ? 0.82 : 1);
      ctx.strokeStyle = col.bg; ctx.lineWidth = 3.5; ctx.strokeText(text, sx, ly);
      ctx.fillStyle = col.fg; ctx.fillText(text, sx, ly);
    }
    // member count inside each group bubble
    ctx.font = `600 13px ${col.font}`;
    for (let i = 0; i < sim.n; i++) {
      const n = this.infos[i];
      if (!n.group) continue;
      const r = sim.r[i] * k;
      if (r < 11) continue;
      ctx.globalAlpha = Math.max(this.cur[i], 0.35); ctx.fillStyle = col.fg;
      ctx.fillText(String(this.litCount.get(i) ?? n.count), sim.x[i] * k + this.view.tx, sim.y[i] * k + this.view.ty + 4.5);
    }
    // hull chips (click collapses the group): a pill with the group colour dot
    ctx.font = `500 11px ${col.font}`;
    for (const g of hullGeo) {
      const text = `${g.h.label} · ${g.h.idx.length}   ×`, w = this.textW(text) + 26;
      const x = Math.min(Math.max(g.cx * k + this.view.tx, w / 2 + 4), this.w - w / 2 - 4), y = Math.min(Math.max(g.cy * k + this.view.ty - g.r * k - 10, 14), this.h - 14);
      const box = { key: g.h.key, x0: x - w / 2, y0: y - 10, x1: x + w / 2, y1: y + 10 };
      this.chips.push(box);
      const color = this.colorOf(g.h.color);
      ctx.globalAlpha = 0.97; ctx.fillStyle = col.card; ctx.strokeStyle = col.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(box.x0, box.y0, w, 20, 10); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(box.x0 + 10, y, 3.5, 0, TAU); ctx.fill();
      ctx.fillStyle = col.fg; ctx.fillText(text, x + 6, y + 4);
    }
    ctx.globalAlpha = 1;
  }

  /** Segment of an edge in world coordinates; it stops at the rim of a group bubble instead of running through it. */
  private seg(e: { a: number; b: number }): [number, number, number, number] {
    const s = this.sim!, ax = s.x[e.a], ay = s.y[e.a], bx = s.x[e.b], by = s.y[e.b];
    const ga = this.infos[e.a].group, gb = this.infos[e.b].group;
    if (!ga && !gb) return [ax, ay, bx, by];
    const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const ra = ga ? s.r[e.a] : 0, rb = gb ? s.r[e.b] : 0;
    if (ra + rb >= d) return [ax, ay, ax, ay];
    return [ax + ux * ra, ay + uy * ra, bx - ux * rb, by - uy * rb];
  }

  /** Quadratic curve of an edge: [x0, y0, cx, cy, x1, y1]. Bends to the same side for a given pair (lower index first), so parallel links never cross over. */
  private curve(e: { a: number; b: number }): [number, number, number, number, number, number] {
    const q = this.seg(e), dx = q[2] - q[0], dy = q[3] - q[1], sign = e.a < e.b ? 1 : -1;
    return [q[0], q[1], (q[0] + q[2]) / 2 - dy * BEND * sign, (q[1] + q[3]) / 2 + dx * BEND * sign, q[2], q[3]];
  }

  /** Colour of a node / hull: a type token or one of the four --mem-* tokens by index. */
  private colorOf(key: string): string {
    const t = this.colors.types;
    if (key.startsWith("type:")) return t[key.slice(5) as MemoryType] ?? this.colors.fg;
    return [t.fact, t.decision, t.procedure, t.episode][Number(key.slice(4)) % 4] ?? this.colors.fg;
  }

  /** Label text: groups carry name + count (and "m of n" while a search lights them). */
  private labelOf(i: number): string {
    const n = this.infos[i];
    if (!n.group) return n.label;
    const m = this.litCount.get(i);
    return this.matches && m !== undefined ? `${n.label} · ${m} of ${n.count}` : `${n.label} · ${n.count}`;
  }

  private layoutLabels(moving: boolean): void {
    const sim = this.sim;
    if (!sim) return;
    const k = this.view.k, now = performance.now();
    const key = [Math.round(k * 50), Math.round(this.view.tx / 4), Math.round(this.view.ty / 4), this.hover, this.hoverEdge, this.selected, this.matches?.size ?? -1, this.infos.length, this.w | 0, this.h | 0, sim.settled ? 1 : 0].join("|");
    if (key === this.labelKey && !moving) return;
    if (moving && now - this.labelAt < 140 && this.placed.length) return;
    this.labelKey = key; this.labelAt = now;
    const forced = new Set<number>();
    if (this.selected >= 0) forced.add(this.selected);
    if (this.hover >= 0) forced.add(this.hover);
    if (this.matches) for (const i of this.matches) forced.add(i);
    for (let i = 0; i < this.infos.length; i++) if (this.infos[i].group) forced.add(i);
    const cand = (i: number, force: boolean) => ({ id: this.infos[i].id, sx: sim.x[i] * k + this.view.tx, sy: sim.y[i] * k + this.view.ty, r: Math.max(sim.r[i] * k, 3), w: this.textW(this.labelOf(i)), force });
    const items = [...forced].map((i) => cand(i, true));
    if (!this.matches && this.hover < 0 && this.hoverEdge < 0) for (const i of this.order()) if (!forced.has(i)) items.push(cand(i, false));
    this.placed = placeLabels(items, { w: this.w, h: this.h }, { max: 60, pad: 4, height: 16 });
    this.labelCount++;
  }

  private orderCache: { key: string; list: number[] } = { key: "", list: [] };
  /** pinned first, then by degree, then by index: stable label priority */
  private order(): number[] {
    const key = this.key + "#" + this.edges.length;
    if (this.orderCache.key === key) return this.orderCache.list;
    const idx = this.infos.map((_, i) => i);
    idx.sort((a, b) => Number(this.infos[b].pinned) - Number(this.infos[a].pinned) || (this.nbrs[b]?.length ?? 0) - (this.nbrs[a]?.length ?? 0) || a - b);
    this.orderCache = { key, list: idx };
    return idx;
  }

  private syncAttrs(): void {
    const c = this.canvas, s = this.sim;
    c.dataset.nodes = String(this.infos.length);
    c.dataset.running = s && !s.settled && !this.reduced ? "1" : "0";
    c.dataset.hover = this.hover >= 0 ? this.infos[this.hover].id : "";
    c.dataset.hoverEdge = this.hoverEdge >= 0 ? String(this.hoverEdge) : "";
    c.dataset.hulls = String(this.hulls.length);
    c.dataset.selected = this.selected >= 0 ? this.infos[this.selected].id : "";
    c.dataset.match = this.matches ? String(this.matches.size) : "";
    c.dataset.labels = String(this.labelCount);
    c.dataset.reduced = this.reduced ? "1" : "0";
  }

  /* ---------- read-only hooks for tests and tooling ---------- */

  private api() {
    const self = this;
    const screen = (i: number) => { const s = self.sim!, k = self.view.k; return { x: s.x[i] * k + self.view.tx, y: s.y[i] * k + self.view.ty, r: Math.max(s.r[i] * k, 3) }; };
    return {
      ids: () => self.infos.map((n) => n.id),
      node: (id: string) => {
        const s = self.sim, i = s ? s.indexOf(id) : -1;
        if (!s || i < 0) return null;
        const n = self.infos[i];
        return { ...screen(i), world: { x: s.x[i], y: s.y[i] }, color: self.colorOf(n.color), colorKey: n.color, pinned: n.pinned, forgotten: n.forgotten, alpha: self.cur[i], target: self.tgt[i], selected: i === self.selected, label: self.labelOf(i), group: n.group, groupKey: n.groupKey, count: n.count, litCount: self.litCount.get(i) ?? null };
      },
      view: () => ({ ...self.view }),
      rect: () => self.canvas.getBoundingClientRect().toJSON(),
      size: () => ({ w: self.w, h: self.h, dpr: self.dpr, bitmap: [self.canvas.width, self.canvas.height] }),
      labels: () => self.placed.map((l) => ({ ...l, text: self.labelOf(self.sim!.indexOf(l.id)) })),
      edges: () => self.edges.map((e, i) => ({ a: self.infos[e.a].id, b: self.infos[e.b].id, count: e.count, sup: e.sup, strength: e.s, bright: self.eBright[i] === 1 })),
      hulls: () => self.hulls.map((h) => ({ key: h.key, label: h.label, members: h.idx.length })),
      chips: () => self.chips.map((c) => ({ ...c })),
      tooltip: () => (self.tip.style.display === "none" ? "" : self.tip.textContent ?? ""),
      fitSubset: () => !!self.fitSubset,
      running: () => !!self.sim && !self.sim.settled && !self.reduced,
      /** finish the simulation synchronously (deterministic tests) */
      settleNow: () => { self.sim?.run(2000); if (self.autoFit) self.fit(false); self.request(); },
      stats: () => { const s = [...self.samples].sort((a, b) => a - b); return { frames: s.length, medianMs: s[Math.floor(s.length / 2)] ?? 0, p95Ms: s[Math.floor(s.length * 0.95)] ?? 0, maxMs: s[s.length - 1] ?? 0 }; },
      resetStats: () => { self.samples = []; },
      colors: () => self.colors,
      reducedMotion: () => self.reduced,
      seed: () => self.seedUsed,
      positionsKey: () => (self.sim ? Array.from(self.sim.x.slice(0, 6)).map((v) => v.toFixed(1)).join(",") : ""),
    };
  }
}

/* ===================================================================================================================== */

interface Props {
  memories: Memory[];
  graph: MemoryGraph | null;
  loading: boolean;
  /** "local" when the runtime endpoint failed and edges were computed in the browser */
  source: "runtime" | "local";
  /** ids that match the current search / type filter; null = nothing to highlight */
  matches: Set<string> | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const MIN_DEFAULT = 0.55;

/** Icon-only action with the shared tooltip (the aria-label stays on the button). */
function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label={label} onClick={onClick}>{children}</Button></TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

const GROUP_MODES: Array<[GroupMode, string]> = [["none", "Individual"], ["type", "Type"], ["topic", "Topic"], ["author", "Author"]];
const GROUP_DEFAULT_ABOVE = 40; // more memories than this: grouped (by type) is the default view

export function MemoryGraphView({ memories, graph, loading, source, matches, selectedId, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const focusRef = useRef<string | null>(null);
  /** memory id -> id of the node that showed it in the previous picture (bubble or itself): where new nodes grow out of */
  const prevDisplay = useRef(new Map<string, string>());
  const [seed, setSeed] = useState(1);
  const [minSim, setMinSim] = useState(MIN_DEFAULT);
  const [showSim, setShowSim] = useState(true);
  const [showSup, setShowSup] = useState(true);
  const [layoutMs, setLayoutMs] = useState(0);
  const [groupBy, setGroupBy] = useState<GroupMode | null>(null); // null = automatic (by size)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const byId = useMemo(() => new Map(memories.map((m) => [m.id, m])), [memories]);
  const nodes = useMemo(() => (graph?.nodes ?? []).filter((n) => byId.has(n.id)), [graph, byId]);
  const mode = graph?.mode ?? "keyword";
  // The runtime already applied top-k; the slider only hides weaker edges. Keyword scores run lower, hence the 0.6 scale (same as the server).
  const threshold = mode === "keyword" ? minSim * 0.6 : minSim;
  const allEdges = useMemo(() => (graph?.edges ?? []).filter((e) => byId.has(e.source) && byId.has(e.target)), [graph, byId]);
  const layoutFloor = mode === "keyword" ? 0.12 : 0.3;
  const effMode: GroupMode = groupBy ?? (nodes.length > GROUP_DEFAULT_ABOVE ? "type" : "none");

  const degree = useMemo(() => { const d = new Map<string, number>(); for (const e of allEdges) { d.set(e.source, (d.get(e.source) ?? 0) + 1); d.set(e.target, (d.get(e.target) ?? 0) + 1); } return d; }, [allEdges]);
  const layoutEdges = useMemo<GEdge[]>(() => allEdges.filter((e) => e.kind === "supersedes" || e.weight >= layoutFloor), [allEdges, layoutFloor]);
  const edges = useMemo<GEdge[]>(() => allEdges.filter((e) => (e.kind === "supersedes" ? showSup : showSim && e.weight >= threshold)), [allEdges, showSim, showSup, threshold]);

  // Grouping (pure, src/lib/memory-groups.ts): groups, which of them are open, and the displayed nodes / folded edges.
  const gmems = useMemo(() => nodes.map((n) => { const m = byId.get(n.id)!; return { id: m.id, type: m.type, title: m.title, text: m.text, author: m.author }; }), [nodes, byId]);
  const groups = useMemo(() => groupMemories(gmems, layoutEdges, effMode, { minWeight: layoutFloor }), [gmems, layoutEdges, effMode, layoutFloor]);
  const auto = useMemo(() => autoExpand(groups, matches), [groups, matches]);
  const open = useMemo<ReadonlySet<string>>(() => new Set(groups.filter((g) => expanded.has(g.key) || auto.has(g.key)).map((g) => g.key)), [groups, expanded, auto]);
  const display = useMemo(() => buildDisplay(gmems, groups, open, layoutEdges), [gmems, groups, open, layoutEdges]);
  const shown = useMemo(() => buildDisplay(gmems, groups, open, edges), [gmems, groups, open, edges]);

  const infos = useMemo<NodeInfo[]>(() => {
    const gby = new Map(groups.map((g) => [g.key, g]));
    const hullOf = new Map<string, string>();
    for (const h of display.hulls) for (const m of h.members) hullOf.set(m, h.key);
    const prev = prevDisplay.current;
    const seedOf = (id: string, members: string[]): string[] => { const out = new Set<string>(); for (const m of members) { const p = prev.get(m); if (p && p !== id) out.add(p); } return [...out]; };
    return display.nodes.map((dn): NodeInfo => {
      if (dn.kind === "group") {
        const g = gby.get(dn.groupKey!)!, r = groupRadius(dn.count);
        return { id: dn.id, r, pinned: false, forgotten: false, color: g.color, title: `${g.label} · ${dn.count} ${dn.count === 1 ? "memory" : "memories"}. Click to expand, double click to focus.`, label: g.label, count: dn.count, group: true, groupKey: g.key, hull: null, charge: Math.max(1, Math.pow(r / 8, 1.4)), seedFrom: seedOf(dn.id, gby.get(dn.groupKey!)!.members) };
      }
      const m = byId.get(dn.id)!;
      const r = 5 + Math.min(3, (degree.get(m.id) ?? 0) * 0.5) + Math.min(2, Math.sqrt(m.text.length / 800)) + (m.pinned ? 4 : 0);
      return { id: m.id, r, pinned: m.pinned, forgotten: m.invalidatedAt !== null, color: "type:" + m.type, title: titleOf(m), label: truncate(titleOf(m), 24), count: 1, group: false, groupKey: null, hull: hullOf.get(dn.id) ?? null, charge: 1, seedFrom: seedOf(dn.id, [dn.id]) };
    });
  }, [display, groups, byId, degree]);
  const hulls = useMemo(() => display.hulls.map((h) => ({ key: h.key, label: h.label, color: h.color, members: h.members })), [display]);
  const simLinks = useMemo(() => display.edges.map((e) => ({ source: e.source, target: e.target, weight: e.aggregated && e.kind !== "supersedes" ? Math.min(0.95, e.weight * (0.6 + 0.4 * Math.min(1, e.count / 8))) : e.weight })), [display]);
  const drawEdges = useMemo<EdgeIn[]>(() => {
    const maxCount = Math.max(1, ...shown.edges.filter((e) => e.aggregated).map((e) => e.count));
    return shown.edges.map((e) => ({
      source: e.source, target: e.target, kind: e.kind, count: e.count,
      strength: e.aggregated ? 0.25 + 0.75 * Math.min(1, Math.log1p(e.count) / Math.log1p(maxCount)) : Math.min(Math.max((e.weight - threshold) / Math.max(1 - threshold, 0.05), 0), 1),
    }));
  }, [shown, threshold]);
  const simCount = shown.edges.filter((e) => e.kind !== "supersedes").reduce((n, e) => n + e.count, 0);
  const supCount = shown.edges.filter((e) => e.kind === "supersedes").reduce((n, e) => n + e.count, 0);
  const lit = useMemo(() => (matches ? litNodes(matches, display.groupOf, open) : null), [matches, display, open]);
  const selDisplay = selectedId ? displayIdOf(selectedId, display.groupOf, open) : null;

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current, tip = tipRef.current;
    if (!canvas || !wrap || !tip) return;
    const engine = new GraphEngine(canvas, wrap, tip, {
      onSelect: (id) => selectRef.current(id), onLayout: setLayoutMs,
      onToggleGroup: (key) => setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; }),
      onFocusGroup: (key) => { focusRef.current = key; setExpanded((prev) => new Set(prev).add(key)); },
    });
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  // Layout depends on the data, the grouping and the seed only (not on the slider or toggles), so dragging them never moves nodes.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.setGraph(infos, simLinks, seed, hulls);
    const next = new Map<string, string>();
    for (const dn of display.nodes) { if (dn.kind === "group") { for (const m of groups.find((g) => g.key === dn.groupKey)!.members) next.set(m, dn.id); } else next.set(dn.id, dn.id); }
    prevDisplay.current = next;
    if (focusRef.current) { e.focusGroup(focusRef.current); focusRef.current = null; }
  }, [infos, simLinks, seed, hulls, display, groups]);
  useEffect(() => { engineRef.current?.setEdges(drawEdges); }, [drawEdges, infos, seed]);
  useEffect(() => { engineRef.current?.setHighlight(lit, selDisplay); }, [lit, selDisplay, infos, seed]);

  const empty = !loading && nodes.length === 0;
  const fit = useCallback(() => engineRef.current?.fit(true), []);

  const meta = `${nodes.length} ${nodes.length === 1 ? "memory" : "memories"}${effMode !== "none" ? ` · ${groups.length} groups` : ""} · ${mode === "semantic" ? "embedding" : "keyword"} similarity${source === "local" ? " (computed locally)" : ""}${layoutMs ? ` · layout ${layoutMs} ms` : ""}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="memory-graph">
      <div className="mem-graph-toolbar flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="mem-eyebrow">Group</span>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={effMode} aria-label="Group by" data-testid="group-mode"
            onValueChange={(v) => { if (v) { setGroupBy(v as GroupMode); setExpanded(new Set()); } }}>
            {GROUP_MODES.map(([v, label]) => <ToggleGroupItem key={v} value={v} data-testid={`group-${v}`} className="px-2.5 text-xs">{label}</ToggleGroupItem>)}
          </ToggleGroup>
          {effMode !== "none" && (
            <span className="flex items-center">
              <Button type="button" size="xs" variant="ghost" data-testid="expand-all" onClick={() => setExpanded(new Set(groups.map((g) => g.key)))}><IconArrowsMaximize size={12} aria-hidden />Expand all</Button>
              <Button type="button" size="xs" variant="ghost" data-testid="collapse-all" onClick={() => setExpanded(new Set())}><IconArrowsMinimize size={12} aria-hidden />Collapse</Button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="mem-eyebrow">Similarity</span>
            <Slider aria-label="Min similarity" className="w-28" min={0.2} max={0.95} step={0.05} value={[minSim]} onValueChange={(v) => setMinSim(v[0])} />
            <span className="w-8 font-mono text-[11px] tabular-nums text-muted-foreground" data-testid="min-sim-value">{minSim.toFixed(2)}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5"><Checkbox checked={showSim} onCheckedChange={(c) => setShowSim(c === true)} aria-label="Similarity links" />Similar <span className="mem-count" data-testid="sim-count">{simCount}</span></label>
          <label className="flex cursor-pointer items-center gap-1.5"><Checkbox checked={showSup} onCheckedChange={(c) => setShowSup(c === true)} aria-label="Superseded links" />Superseded <span className="mem-count" data-testid="sup-count">{supCount}</span></label>
        </div>
      </div>

      <div ref={wrapRef} className="mem-stage relative min-h-0 flex-1 overflow-hidden rounded-xl border">
        {loading && <div className="absolute inset-0 z-10 flex items-center justify-center" role="status" aria-label="Loading graph"><Spinner /></div>}
        {empty && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm font-medium">No memories to map yet</p>
            <p className="text-xs text-muted-foreground">Memories appear here as connected discs once agents save them.</p>
          </div>
        )}
        <canvas ref={canvasRef} data-testid="graph-canvas" role="img" tabIndex={0} aria-label={`Memory graph, ${nodes.length} memories. Drag to pan, scroll or pinch to zoom, drag a node to move it, click to open. Keys: plus, minus, zero to fit.`}
          className="memgraph absolute inset-0 block size-full cursor-grab touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset" />
        <div ref={tipRef} role="tooltip" className="mem-float pointer-events-none absolute z-10 hidden max-w-72 rounded-lg px-2.5 py-1.5 text-xs leading-snug" />

        <p className="mem-float pointer-events-none absolute top-3 left-3 z-[1] max-w-[calc(100%-5rem)] truncate rounded-full px-2.5 py-1 text-[11px] text-muted-foreground" data-testid="graph-meta">{meta}</p>

        <TooltipProvider delayDuration={200}>
          <div className="mem-float absolute top-3 right-3 flex flex-col gap-0.5 rounded-xl p-1">
            <ToolButton label="Zoom in" onClick={() => engineRef.current?.zoomBy(1.3)}><IconPlus size={14} /></ToolButton>
            <ToolButton label="Zoom out" onClick={() => engineRef.current?.zoomBy(1 / 1.3)}><IconMinus size={14} /></ToolButton>
            <span aria-hidden className="mx-1.5 my-0.5 h-px bg-border" />
            <ToolButton label="Fit to view" onClick={fit}><IconScan size={14} /></ToolButton>
            <ToolButton label="Reset layout" onClick={() => setSeed((s) => s + 1)}><IconRefresh size={14} /></ToolButton>
          </div>
        </TooltipProvider>

        <div className="mem-float absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2.5 py-1.5 text-[11px] text-muted-foreground" data-testid="graph-legend">
          {MEMORY_TYPES.map((t) => <span key={t} className="flex items-center gap-1.5 text-foreground"><span aria-hidden className="size-2.5 rounded-full" style={{ background: typeColor(t) }} />{TYPE_META[t].label}</span>)}
          <span aria-hidden className="h-3 w-px bg-border" />
          <span className="flex items-center gap-1.5"><svg width="22" height="10" aria-hidden><path d="M1 8 Q11 0 21 8" fill="none" stroke="var(--mem-link)" strokeWidth="1.5" /></svg>similar</span>
          <span className="flex items-center gap-1.5"><svg width="22" height="10" aria-hidden><path d="M1 8 Q9 1 16 5" fill="none" stroke="var(--mem-link-supersedes)" strokeWidth="1.5" strokeDasharray="3 2.5" /><path d="M15 2 L21 7 L13.5 8 z" fill="var(--mem-link-supersedes)" /></svg>superseded by</span>
          {effMode !== "none" && <span className="flex items-center gap-1.5"><svg width="14" height="14" aria-hidden><circle cx="7" cy="7" r="6" fill="var(--muted-foreground)" fillOpacity="0.18" stroke="var(--muted-foreground)" strokeWidth="1.3" /></svg>group · width = links</span>}
          <span className="flex items-center gap-1.5"><svg width="14" height="14" aria-hidden><circle cx="7" cy="7" r="6" fill="none" stroke="var(--foreground)" strokeWidth="1.2" /><circle cx="7" cy="7" r="3.5" fill="var(--foreground)" /></svg>pinned</span>
          <span className="flex items-center gap-1.5"><svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--foreground)" strokeWidth="1.2" strokeDasharray="2.5 2" /></svg>forgotten</span>
        </div>
      </div>
    </div>
  );
}
