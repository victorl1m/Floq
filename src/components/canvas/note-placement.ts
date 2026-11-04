// Finds a free, grid-snapped spot for a note an agent created (or that predates canvas mirroring).
export interface Rect { x: number; y: number; w: number; h: number }

export const PLACEMENT_GRID = 20;
const GAP = 40;
const snap = (value: number) => Math.round(value / PLACEMENT_GRID) * PLACEMENT_GRID;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w + GAP / 2 && a.x + a.w + GAP / 2 > b.x && a.y < b.y + b.h + GAP / 2 && a.y + a.h + GAP / 2 > b.y;

/**
 * Tries the right of the anchor, then below, left and above, at growing distances, and returns the first spot
 * that does not touch any occupied rect. With no anchor it starts at the right edge of everything on the canvas.
 */
export function findFreeSpot(size: { w: number; h: number }, occupied: Rect[], anchor?: Rect): { x: number; y: number } {
  const free = (x: number, y: number) => {
    const rect = { x, y, w: size.w, h: size.h };
    return !occupied.some((other) => overlaps(rect, other));
  };
  if (!anchor) {
    const right = occupied.length ? Math.max(...occupied.map((r) => r.x + r.w)) + GAP : 0;
    const top = occupied.length ? Math.min(...occupied.map((r) => r.y)) : 0;
    for (let row = 0; row < 200; row++) {
      const y = snap(top + row * (size.h + GAP));
      if (free(snap(right), y)) return { x: snap(right), y };
    }
    return { x: snap(right), y: snap(top) };
  }
  for (let ring = 0; ring < 40; ring++) {
    const dx = ring * (size.w + GAP);
    const dy = ring * (size.h + GAP);
    const candidates = [
      { x: anchor.x + anchor.w + GAP + dx, y: anchor.y },
      { x: anchor.x + anchor.w + GAP + dx, y: anchor.y + dy / 2 },
      { x: anchor.x, y: anchor.y + anchor.h + GAP + dy },
      { x: anchor.x - size.w - GAP - dx, y: anchor.y },
      { x: anchor.x, y: anchor.y - size.h - GAP - dy },
      { x: anchor.x + anchor.w + GAP + dx, y: anchor.y - dy / 2 },
    ];
    for (const c of candidates) {
      const x = snap(c.x);
      const y = snap(c.y);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: snap(anchor.x + anchor.w + GAP), y: snap(anchor.y) };
}
