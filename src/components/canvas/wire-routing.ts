import { Position } from "@xyflow/react";
import { recruitEndpoints } from "./wire-endpoints";

export type Rect = { x: number; y: number; width: number; height: number };
export type Pt = { x: number; y: number };
type Anchor = Pt & { position: Position };
export type Curve = { a: Anchor; c1: Pt; c2: Pt; b: Anchor };

const PAD = 16;
const SAMPLES = 28;
const DIR: Record<Position, Pt> = { [Position.Top]: { x: 0, y: -1 }, [Position.Bottom]: { x: 0, y: 1 }, [Position.Left]: { x: -1, y: 0 }, [Position.Right]: { x: 1, y: 0 } };

export function at(curve: Curve, t: number): Pt {
  const u = 1 - t;
  const { a, c1, c2, b } = curve;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}
export const inside = (point: Pt, rect: Rect, pad: number) => point.x > rect.x - pad && point.x < rect.x + rect.width + pad && point.y > rect.y - pad && point.y < rect.y + rect.height + pad;
function collisions(curve: Curve, obstacles: Rect[]) {
  let hits = 0;
  for (let i = 1; i < SAMPLES; i++) if (obstacles.some((rect) => inside(at(curve, i / SAMPLES), rect, PAD))) hits++;
  return hits;
}
function length(curve: Curve) {
  let total = 0, prev = at(curve, 0);
  for (let i = 1; i <= 12; i++) { const point = at(curve, i / 12); total += Math.hypot(point.x - prev.x, point.y - prev.y); prev = point; }
  return total;
}
function curveOf(a: Anchor, b: Anchor, reachA: number, reachB = reachA): Curve {
  const da = DIR[a.position], db = DIR[b.position];
  return { a, b, c1: { x: a.x + da.x * reachA, y: a.y + da.y * reachA }, c2: { x: b.x + db.x * reachB, y: b.y + db.y * reachB } };
}
const side = (rect: Rect, position: Position, shift = 0): Anchor => {
  if (position === Position.Top) return { x: rect.x + rect.width / 2 + shift, y: rect.y, position };
  if (position === Position.Bottom) return { x: rect.x + rect.width / 2 + shift, y: rect.y + rect.height, position };
  if (position === Position.Left) return { x: rect.x, y: rect.y + rect.height / 2 + shift, position };
  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 + shift, position };
};

export function anchor(from: Rect, to: Rect): Anchor {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const horizontal = Math.abs(dx) * from.height > Math.abs(dy) * from.width;
  if (horizontal) return dx > 0 ? { x: from.x + from.width, y: from.y + from.height / 2, position: Position.Right } : { x: from.x, y: from.y + from.height / 2, position: Position.Left };
  return dy > 0 ? { x: from.x + from.width / 2, y: from.y + from.height, position: Position.Bottom } : { x: from.x + from.width / 2, y: from.y, position: Position.Top };
}

/** Natural floating route first; if it crosses another node, try detours while preserving recruit endpoints. */
export function route(from: Rect, to: Rect, obstacles: Rect[], fan: number, recruit = false): Curve {
  const natural = (() => {
    const fixed = recruitEndpoints(from, to, fan);
    const a = recruit ? { ...fixed.a, position: Position.Bottom } : anchor(from, to);
    const b = recruit ? { ...fixed.b, position: Position.Top } : anchor(to, from);
    const horizontal = a.position === Position.Left || a.position === Position.Right;
    const reach = Math.max(40, (horizontal ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y)) * 0.35);
    const shifted = (p: Anchor): Anchor => recruit ? p : (horizontal ? { ...p, y: p.y + fan } : { ...p, x: p.x + fan });
    return curveOf(shifted(a), shifted(b), reach);
  })();
  const candidates = [natural];
  if (collisions(natural, obstacles) > 0) {
    const left = Math.min(from.x, to.x), right = Math.max(from.x + from.width, to.x + to.width);
    const between = obstacles.filter((rect) => rect.x < right && rect.x + rect.width > left);
    for (const position of [Position.Bottom, Position.Top] as const) {
      const fixed = recruitEndpoints(from, to, fan);
      const a = recruit ? { ...fixed.a, position: Position.Bottom } : side(from, position, fan);
      const b = recruit ? { ...fixed.b, position: Position.Top } : side(to, position, fan);
      const edgeY = position === Position.Bottom
        ? Math.max(a.y, b.y, ...between.map((rect) => rect.y + rect.height)) + 36
        : Math.min(a.y, b.y, ...between.map((rect) => rect.y)) - 36;
      candidates.push(curveOf(a, b, Math.max(70, Math.abs(edgeY - a.y) / 0.75), Math.max(70, Math.abs(edgeY - b.y) / 0.75)));
    }
  }
  let best = natural, bestScore = Infinity;
  for (const [index, candidate] of candidates.entries()) {
    const score = collisions(candidate, obstacles) * 10000 + length(candidate) + index * 5;
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

export const pathOf = (curve: Curve) => `M ${curve.a.x},${curve.a.y} C ${curve.c1.x},${curve.c1.y} ${curve.c2.x},${curve.c2.y} ${curve.b.x},${curve.b.y}`;
