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

export interface StackNote { id: string; w: number; h: number; kind?: string | null; title?: string | null }

const KIND_ORDER: Record<string, number> = { system: 0, memory: 1 };
const STACK_GAP = 24;
const COLUMN_GAP = 40;
/** A column wraps into the next one once it is taller than this. */
const COLUMN_MAX_HEIGHT = 1500;

/**
 * Stacks notes into tidy vertical columns whose right edge sits one gap left of `left`, top-aligned at `top`.
 * System notes come first, then memory, then plain notes (by title). Each note keeps its own size; a column
 * is as wide as its widest note and notes in it share a left edge. Returns grid-snapped positions by note id.
 */
export function stackNotes(notes: readonly StackNote[], left: number, top: number, gap = COLUMN_GAP * 2): Record<string, { x: number; y: number }> {
  const sorted = [...notes].sort((a, b) => (KIND_ORDER[a.kind ?? ""] ?? 2) - (KIND_ORDER[b.kind ?? ""] ?? 2) || (a.title ?? "").localeCompare(b.title ?? "") || a.id.localeCompare(b.id));
  const columns: StackNote[][] = [];
  let height = 0;
  for (const note of sorted) {
    const column = columns[columns.length - 1];
    if (!column || (height > 0 && height + STACK_GAP + note.h > COLUMN_MAX_HEIGHT)) { columns.push([note]); height = note.h; }
    else { column.push(note); height += STACK_GAP + note.h; }
  }
  const positions: Record<string, { x: number; y: number }> = {};
  let right = left - gap;
  for (const column of columns) {
    const width = Math.max(...column.map((note) => note.w));
    const x = snap(right - width);
    let y = snap(top);
    for (const note of column) {
      positions[note.id] = { x, y };
      y = snap(y + note.h + STACK_GAP);
    }
    right = x - COLUMN_GAP;
  }
  return positions;
}
