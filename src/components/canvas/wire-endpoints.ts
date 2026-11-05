type Rect = { x: number; y: number; width: number; height: number };
type Endpoint = { x: number; y: number; position: "top" | "bottom" };

/** Fixed recruitment endpoints: parent bottom to child top, respecting each node's measured size. */
export function recruitEndpoints(from: Rect, to: Rect, fan: number): { a: Endpoint; b: Endpoint } {
  return {
    a: { x: from.x + from.width / 2 + fan, y: from.y + from.height, position: "bottom" },
    b: { x: to.x + to.width / 2 + fan, y: to.y, position: "top" },
  };
}
