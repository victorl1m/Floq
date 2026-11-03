export const DEFAULT_NODE_SIZE = { width: 520, height: 320 };
const GAP_X = 60;
const GAP_Y = 80;

export interface LayoutItem {
  id: string;
  parentId: string | null;
}

/** Layered tree layout: one row per depth, each parent centred over its children. Roots sit side by side. */
export function layoutTree(
  items: LayoutItem[],
  size: { width: number; height: number } = DEFAULT_NODE_SIZE,
): Record<string, { x: number; y: number }> {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const item of items) {
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
  for (const item of items) if (!placed.has(item.id)) place(item.id, 0);
  return positions;
}
