/**
 * Small deterministic force-directed layout for the Memory graph. Pure TypeScript, no dependencies.
 * Forces: pairwise repulsion, springs along edges (stronger and shorter with weight), gravity to the origin
 * (pinned nodes feel more of it, so they sit near the centre). Runs a bounded number of ticks with a cooling alpha,
 * then returns the settled positions. Same input -> same output (seeded initial jitter, fixed iteration order).
 */

export interface ForceNode { id: string; pinned?: boolean }
export interface ForceLink { source: string; target: string; weight: number }
export interface ForceOptions { ticks?: number; seed?: number; linkDistance?: number; repulsion?: number }
export interface Point { x: number; y: number }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Ticks to run for n nodes: enough to settle small graphs, bounded so 400 nodes stays under ~150 ms. */
export const defaultTicks = (n: number): number => (n <= 80 ? 300 : n <= 200 ? 220 : 160);

export function layoutForce(nodes: ForceNode[], links: ForceLink[], opts: ForceOptions = {}): Map<string, Point> {
  const n = nodes.length;
  const out = new Map<string, Point>();
  if (n === 0) return out;
  const rand = mulberry32(opts.seed ?? 1);
  const dist0 = opts.linkDistance ?? 70;
  const rep = opts.repulsion ?? 2600;
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const spread = dist0 * Math.sqrt(n) * 0.6;
  // Golden-angle spiral (pinned first so they start inside) plus seeded jitter breaks symmetry deterministically.
  const order = nodes.map((_, i) => i).sort((a, b) => Number(!!nodes[b].pinned) - Number(!!nodes[a].pinned) || a - b);
  order.forEach((i, r) => {
    const rad = spread * Math.sqrt((r + 0.5) / n), ang = r * 2.399963229728653;
    x[i] = Math.cos(ang) * rad + (rand() - 0.5) * 8; y[i] = Math.sin(ang) * rad + (rand() - 0.5) * 8;
  });
  const ls: Array<{ a: number; b: number; w: number }> = [];
  for (const l of links) { const a = idx.get(l.source), b = idx.get(l.target); if (a !== undefined && b !== undefined && a !== b) ls.push({ a, b, w: Math.min(Math.max(l.weight, 0), 1) }); }
  const deg = new Float64Array(n);
  for (const l of ls) { deg[l.a]++; deg[l.b]++; }
  const ticks = opts.ticks ?? defaultTicks(n);
  for (let t = 0; t < ticks; t++) {
    const alpha = Math.pow(1 - t / ticks, 2) * 0.9 + 0.02;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - x[i], dy = y[j] - y[i];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = rand() - 0.5; dy = rand() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
        if (d2 > 160000) continue; // beyond 400px repulsion is negligible: skip for speed
        const f = (rep / d2) * alpha, d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        vx[i] -= fx; vy[i] -= fy; vx[j] += fx; vy[j] += fy;
      }
    }
    for (const l of ls) {
      const dx = x[l.b] - x[l.a], dy = y[l.b] - y[l.a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = dist0 * (1.15 - 0.6 * l.w);
      const k = (0.04 + 0.12 * l.w) * alpha / Math.sqrt(Math.max(1, Math.min(deg[l.a], deg[l.b])));
      const f = (d - target) * k;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      vx[l.a] += fx; vy[l.a] += fy; vx[l.b] -= fx; vy[l.b] -= fy;
    }
    for (let i = 0; i < n; i++) {
      const g = (nodes[i].pinned ? 0.03 : 0.012) * (deg[i] === 0 ? 2 : 1) * (0.4 + alpha);
      vx[i] -= x[i] * g; vy[i] -= y[i] * g;
      vx[i] *= 0.6; vy[i] *= 0.6;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp > 40) { vx[i] *= 40 / sp; vy[i] *= 40 / sp; }
      x[i] += vx[i]; y[i] += vy[i];
    }
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += x[i]; cy += y[i]; }
  cx /= n; cy /= n;
  nodes.forEach((nd, i) => out.set(nd.id, { x: Math.round((x[i] - cx) * 100) / 100, y: Math.round((y[i] - cy) * 100) / 100 }));
  return out;
}

/** Bounding box of positions with a margin, for fit-to-view. */
export function bounds(points: Iterable<Point>, margin = 40): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

/** Scale + translate that fits `b` into a w x h viewport, leaving `pad` (fraction, per side) free; zoom capped at `maxK`. */
export function fitTransform(b: { minX: number; minY: number; maxX: number; maxY: number }, w: number, h: number, opts: { pad?: number; maxK?: number } = {}): { k: number; tx: number; ty: number } {
  const pad = opts.pad ?? 0, maxK = opts.maxK ?? 1.5;
  const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
  const k = Math.min(Math.min((w * (1 - 2 * pad)) / bw, (h * (1 - 2 * pad)) / bh), maxK);
  return { k, tx: w / 2 - ((b.minX + b.maxX) / 2) * k, ty: h / 2 - ((b.minY + b.maxY) / 2) * k };
}

/** Stretch positions (about their centre) so the bounding box has the given width/height aspect: a circular blob then fills a wide pane. */
export function stretchToAspect(points: Map<string, Point>, aspect: number): Map<string, Point> {
  const b = bounds(points.values(), 0);
  const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
  const f = Math.min(Math.max(aspect / (bw / bh), 0.4), 3);
  const sx = Math.sqrt(f), sy = 1 / Math.sqrt(f);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return new Map([...points].map(([id, p]) => [id, { x: Math.round((p.x - cx) * sx * 100) / 100, y: Math.round((p.y - cy) * sy * 100) / 100 }]));
}

/* ------------------------------------------------------------------------------------------------
   Continuous simulation (Obsidian-style): the same forces as `layoutForce`, plus collision, driven tick by tick with a cooling
   alpha that can be re-heated (drag, new data). Typed arrays, no allocation per tick.
   ------------------------------------------------------------------------------------------------ */

export interface SimNode { id: string; pinned?: boolean; /** world radius, used for collision */ r: number; /** repulsion multiplier (group bubbles push harder), default 1 */ charge?: number; /** members of an expanded group share a key: they stay together and other nodes keep out of their hull */ group?: string | null }
export interface SimOptions { /** start these nodes here instead of on the spiral (expand / collapse keeps the picture) */ initial?: Map<string, Point & { /** radius of the disc the node is scattered in around its start */ spread?: number }>; seed?: number; linkDistance?: number; repulsion?: number; /** width / height of the pane: the cloud is stretched to it */ aspect?: number }

export class ForceSim {
  readonly n: number;
  readonly ids: string[];
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly r: Float64Array;
  /** fixed position while dragging (NaN = free) */
  readonly fx: Float64Array;
  readonly fy: Float64Array;
  alpha = 1;
  alphaTarget = 0;
  readonly alphaMin = 0.004;
  readonly alphaDecay = 1 - Math.pow(0.004, 1 / 260);
  readonly velocityDecay = 0.55;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly pinned: Uint8Array;
  private readonly ch: Float64Array;
  private readonly hullOf: Int32Array;
  private readonly hullMembers: number[][] = [];
  private readonly deg: Float64Array;
  private readonly links: Array<{ a: number; b: number; w: number }> = [];
  private readonly dist0: number;
  private readonly rep: number;
  private readonly gx: number;
  private readonly gy: number;
  private readonly aspect: number;
  private tickN = 0;
  private readonly index = new Map<string, number>();
  private readonly rand: () => number;

  constructor(nodes: SimNode[], links: ForceLink[], opts: SimOptions = {}) {
    const n = (this.n = nodes.length);
    this.ids = nodes.map((nd) => nd.id);
    this.x = new Float64Array(n); this.y = new Float64Array(n); this.vx = new Float64Array(n); this.vy = new Float64Array(n);
    this.r = Float64Array.from(nodes.map((nd) => nd.r));
    this.fx = new Float64Array(n).fill(NaN); this.fy = new Float64Array(n).fill(NaN);
    this.pinned = Uint8Array.from(nodes.map((nd) => (nd.pinned ? 1 : 0)));
    this.ch = Float64Array.from(nodes.map((nd) => Math.sqrt(Math.max(nd.charge ?? 1, 0.1))));
    const hk = new Map<string, number>();
    this.hullOf = new Int32Array(n).fill(-1);
    nodes.forEach((nd, i) => { if (nd.group) { if (!hk.has(nd.group)) { hk.set(nd.group, this.hullMembers.length); this.hullMembers.push([]); } this.hullOf[i] = hk.get(nd.group)!; this.hullMembers[hk.get(nd.group)!].push(i); } });
    this.deg = new Float64Array(n);
    this.dist0 = opts.linkDistance ?? 120;
    this.rep = opts.repulsion ?? 7000;
    const aspect = Math.min(Math.max(opts.aspect ?? 1, 0.4), 3);
    // Equilibrium extent ratio x/y ~ sqrt(gy/gx): gx*gy stays constant, gy/gx = aspect^2.
    this.gx = 1 / Math.sqrt(aspect); this.gy = Math.sqrt(aspect); this.aspect = aspect; // half of the stretch comes from anisotropic gravity, the rest from shape()
    this.rand = mulberry32(opts.seed ?? 1);
    nodes.forEach((nd, i) => this.index.set(nd.id, i));
    for (const l of links) {
      const a = this.index.get(l.source), b = this.index.get(l.target);
      if (a !== undefined && b !== undefined && a !== b) { this.links.push({ a, b, w: Math.min(Math.max(l.weight, 0), 1) }); this.deg[a]++; this.deg[b]++; }
    }
    const spread = this.dist0 * Math.sqrt(Math.max(n, 1)) * 0.6;
    const order = nodes.map((_, i) => i).sort((p, q) => Number(!!nodes[q].pinned) - Number(!!nodes[p].pinned) || p - q);
    order.forEach((i, rank) => {
      const rad = spread * Math.sqrt((rank + 0.5) / Math.max(n, 1)), ang = rank * 2.399963229728653;
      this.x[i] = Math.cos(ang) * rad * Math.sqrt(aspect) + (this.rand() - 0.5) * 8;
      this.y[i] = Math.sin(ang) * rad / Math.sqrt(aspect) + (this.rand() - 0.5) * 8;
    });
    if (opts.initial) nodes.forEach((nd, i) => { const p = opts.initial!.get(nd.id); if (p) { const sp = p.spread ?? Math.max(nd.r, 6) * 0.8, a = this.rand() * 6.2832, d = Math.sqrt(this.rand()) * sp; this.x[i] = p.x + Math.cos(a) * d; this.y[i] = p.y + Math.sin(a) * d; } });
  }

  indexOf(id: string): number { return this.index.get(id) ?? -1; }
  get settled(): boolean { return this.alphaTarget === 0 && this.alpha < this.alphaMin; }
  reheat(alpha = 0.35): void { if (this.alpha < alpha) this.alpha = alpha; }

  setRadius(i: number, r: number): void { this.r[i] = r; }

  tick(): void {
    const n = this.n;
    if (n === 0) return;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha, x = this.x, y = this.y, vx = this.vx, vy = this.vy;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - x[i], dy = y[j] - y[i];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = this.rand() - 0.5; dy = this.rand() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
        if (d2 > 160000) continue;
        const d = Math.sqrt(d2), f = (this.rep / Math.max(d2, 25)) * alpha * this.ch[i] * this.ch[j];
        const fxx = (dx / d) * f, fyy = (dy / d) * f;
        vx[i] -= fxx; vy[i] -= fyy; vx[j] += fxx; vy[j] += fyy;
        // collision: positional push so discs never overlap (radius + 3 px air)
        const min = this.r[i] + this.r[j] + 5;
        if (d < min) { const push = ((min - d) / d) * 0.5; x[i] -= dx * push * 0.5; y[i] -= dy * push * 0.5; x[j] += dx * push * 0.5; y[j] += dy * push * 0.5; }
      }
    }
    for (const l of this.links) {
      const dx = x[l.b] - x[l.a], dy = y[l.b] - y[l.a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = this.dist0 * (1.15 - 0.6 * l.w);
      const k = ((0.04 + 0.12 * l.w) * alpha) / Math.sqrt(Math.max(1, Math.min(this.deg[l.a], this.deg[l.b])));
      const f = (d - target) * k, fxx = (dx / d) * f, fyy = (dy / d) * f;
      vx[l.a] += fxx; vy[l.a] += fyy; vx[l.b] -= fxx; vy[l.b] -= fyy;
    }
    this.shape(alpha);
    this.hulls(alpha);
    for (let i = 0; i < n; i++) {
      const g = (this.pinned[i] ? 0.03 : 0.012) * (this.deg[i] === 0 ? 2 : 1) * (0.4 + alpha);
      vx[i] -= x[i] * g * this.gx; vy[i] -= y[i] * g * this.gy;
      if (!Number.isNaN(this.fx[i])) { x[i] = this.fx[i]; y[i] = this.fy[i]; vx[i] = 0; vy[i] = 0; continue; }
      vx[i] *= 1 - this.velocityDecay; vy[i] *= 1 - this.velocityDecay;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp > 40) { vx[i] *= 40 / sp; vy[i] *= 40 / sp; }
      x[i] += vx[i]; y[i] += vy[i];
    }
  }

  /** Expanded groups: members are pulled towards their centroid and everything else is kept out of the hull disc. */
  private hulls(alpha: number): void {
    for (let h = 0; h < this.hullMembers.length; h++) {
      const m = this.hullMembers[h];
      let cx = 0, cy = 0;
      for (const i of m) { cx += this.x[i]; cy += this.y[i]; }
      cx /= m.length; cy /= m.length;
      let R = 0;
      for (const i of m) { R = Math.max(R, Math.hypot(this.x[i] - cx, this.y[i] - cy) + this.r[i]); this.vx[i] -= (this.x[i] - cx) * 0.012 * alpha; this.vy[i] -= (this.y[i] - cy) * 0.012 * alpha; }
      R += 16;
      for (let i = 0; i < this.n; i++) {
        if (this.hullOf[i] === h) continue;
        const dx = this.x[i] - cx, dy = this.y[i] - cy, d = Math.hypot(dx, dy) || 0.01, need = R + this.r[i] + 4;
        if (d < need) { const push = (need - d) * 0.2; this.x[i] += (dx / d) * push; this.y[i] += (dy / d) * push; }
      }
    }
  }

  /** While hot, nudge the bounding box towards the pane's aspect ratio (area preserving) so the settled graph fills a wide pane. */
  private shape(alpha: number): void {
    if (this.aspect === 1 || alpha < this.alphaMin || this.tickN++ % 3 !== 0) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cx = 0, cy = 0;
    for (let i = 0; i < this.n; i++) { x0 = Math.min(x0, this.x[i]); x1 = Math.max(x1, this.x[i]); y0 = Math.min(y0, this.y[i]); y1 = Math.max(y1, this.y[i]); cx += this.x[i]; cy += this.y[i]; }
    cx /= this.n; cy /= this.n;
    const cur = Math.max(x1 - x0, 1) / Math.max(y1 - y0, 1);
    const f = Math.min(Math.max(this.aspect / cur, 0.5), 2);
    const s = Math.pow(f, 0.25 * Math.min(alpha * 25, 1));
    for (let i = 0; i < this.n; i++) { this.x[i] = cx + (this.x[i] - cx) * s; this.y[i] = cy + (this.y[i] - cy) / s; }
  }

  /** Run `ticks` ticks (or until settled), synchronously. */
  run(ticks: number): void { for (let t = 0; t < ticks && !this.settled; t++) this.tick(); }

  positions(): Map<string, Point> {
    const out = new Map<string, Point>();
    for (let i = 0; i < this.n; i++) out.set(this.ids[i], { x: this.x[i], y: this.y[i] });
    return out;
  }
}

export interface LabelCandidate { id: string; sx: number; sy: number; /** screen radius of the node */ r: number; /** text width in px */ w: number; force?: boolean }
export interface PlacedLabel { id: string; x0: number; y0: number; x1: number; y1: number }

/**
 * Greedy label declutter in screen space. Candidates come in priority order; forced ones are always placed (first), the others
 * only when their padded box misses every placed box and lies (partly) inside the view; at most `max` non-forced labels.
 */
export function placeLabels(items: LabelCandidate[], view: { w: number; h: number }, opts: { max?: number; pad?: number; height?: number } = {}): PlacedLabel[] {
  const max = opts.max ?? 60, pad = opts.pad ?? 4, height = opts.height ?? 16;
  const out: PlacedLabel[] = [];
  const box = (c: LabelCandidate): PlacedLabel => ({ id: c.id, x0: c.sx - c.w / 2 - pad, x1: c.sx + c.w / 2 + pad, y0: c.sy + c.r + 1, y1: c.sy + c.r + 1 + height });
  for (const c of items) if (c.force) out.push(box(c));
  let n = 0;
  for (const c of items) {
    if (c.force) continue;
    if (n >= max) break;
    const b = box(c);
    if (b.x1 < 0 || b.x0 > view.w || b.y1 < 0 || b.y0 > view.h) continue;
    let hit = false;
    for (const o of out) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) { hit = true; break; }
    if (!hit) { out.push(b); n++; }
  }
  return out;
}

/** Index of the topmost node under (px, py) in screen space (later nodes are drawn on top), or -1. `slop` widens small nodes. */
export function pickNode(xs: ArrayLike<number>, ys: ArrayLike<number>, rs: ArrayLike<number>, view: { k: number; tx: number; ty: number }, px: number, py: number, slop = 3): number {
  let best = -1, bestD = Infinity;
  for (let i = xs.length - 1; i >= 0; i--) {
    const dx = xs[i] * view.k + view.tx - px, dy = ys[i] * view.k + view.ty - py;
    const r = Math.max(rs[i] * view.k, 3) + slop, d2 = dx * dx + dy * dy;
    if (d2 <= r * r && d2 < bestD) { best = i; bestD = d2; }
  }
  return best;
}
