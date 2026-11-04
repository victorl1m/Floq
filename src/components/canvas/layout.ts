export const DEFAULT_NODE_SIZE = { width: 520, height: 320 };
const GAP_X = 60;
const GAP_Y = 80;

export interface LayoutItem {
  id: string;
  parentId: string | null;
  /** False for agents with no link at all: they are packed into a grid below the linked tree. */
  linked?: boolean;
}

/** Layered tree layout: one row per depth, each parent centred over its children. Roots sit side by side. */
export function layoutTree(
  items: LayoutItem[],
  size: { width: number; height: number } = DEFAULT_NODE_SIZE,
): Record<string, { x: number; y: number }> {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const loose = items.filter((item) => item.linked === false && !items.some((other) => other.parentId === item.id));
  const looseIds = new Set(loose.map((item) => item.id));
  for (const item of items) {
    if (looseIds.has(item.id)) continue;
    if (item.parentId && ids.has(item.parentId)) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id]);
    else roots.push(item.id);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const placed = new Set<string>();
  const slot = size.width + GAP_X;
  let nextLeaf = 0;

  // Returns the node's centre in leaf-slot units; `placed` also guards against parent cycles.
  function place(id: string, depth: number): number {
    placed.add(id);
    const kids = (children.get(id) ?? []).filter((child) => !placed.has(child));
    const centres = kids.map((child) => place(child, depth + 1));
    const centre = centres.length ? (centres[0] + centres[centres.length - 1]) / 2 : nextLeaf++;
    positions[id] = { x: centre * slot, y: depth * (size.height + GAP_Y) };
    return centre;
  }

  for (const root of roots) if (!placed.has(root)) place(root, 0);
  // Members of a pure cycle have no root; lay them out as extra roots instead of dropping them.
  for (const item of items) if (!placed.has(item.id) && !looseIds.has(item.id)) place(item.id, 0);
  // Unlinked agents: their own grid under the tree, so nothing unrelated sits on a linked row.
  const treeBottom = Object.values(positions).reduce((max, point) => Math.max(max, point.y), -Infinity);
  const top = Number.isFinite(treeBottom) ? treeBottom + size.height + GAP_Y * 2 : 0;
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(loose.length))));
  loose.forEach((item, index) => {
    positions[item.id] = { x: (index % columns) * slot, y: top + Math.floor(index / columns) * (size.height + GAP_Y) };
  });
  return positions;
}

export interface FloorLayoutItem extends LayoutItem {
  /** Floor (workspace) id the agent belongs to. */
  floorId: string;
}

const FLOOR_GAP = 140;

/**
 * Runs `layoutTree` per floor and stacks the floors vertically. `floorOrder` is ground floor first;
 * the ground floor ends up at the bottom, higher floors above it. Floors without agents are skipped.
 * Returns node positions plus the floor ids that have agents, ground floor first.
 */
export function layoutFloors(
  items: FloorLayoutItem[],
  floorOrder: string[],
  size: { width: number; height: number } = DEFAULT_NODE_SIZE,
): { positions: Record<string, { x: number; y: number }>; floors: string[] } {
  const order = [...floorOrder];
  for (const item of items) if (!order.includes(item.floorId)) order.push(item.floorId);
  const floors = order.filter((id) => items.some((item) => item.floorId === id));
  const positions: Record<string, { x: number; y: number }> = {};
  let top = 0;
  // Walk from the top floor down so the ground floor (first in order) lands lowest.
  for (const floorId of [...floors].reverse()) {
    const members = items.filter((item) => item.floorId === floorId);
    const ids = new Set(members.map((item) => item.id));
    // Parents on another floor do not shape this floor's tree.
    const local = layoutTree(members.map((item) => ({ ...item, parentId: item.parentId && ids.has(item.parentId) ? item.parentId : null })), size);
    let bottom = 0;
    for (const [id, point] of Object.entries(local)) {
      positions[id] = { x: point.x, y: top + point.y };
      bottom = Math.max(bottom, point.y + size.height);
    }
    top += bottom + FLOOR_GAP;
  }
  return { positions, floors };
}
