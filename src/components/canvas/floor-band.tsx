import { ViewportPortal, useStore } from "@xyflow/react";
import { IconGitBranch } from "@tabler/icons-react";
import { useMemo } from "react";
import { shallow } from "zustand/shallow";

export interface FloorInfo {
  id: string;
  label: string;
  nodeIds: string[];
}

const PAD_X = 48;
const PAD_TOP = 64;
const PAD_BOTTOM = 40;
const MIN_HEIGHT = 200;

interface Box { id: string; label: string; count: number; x: number; y: number; w: number; h: number }

/** Labelled background bands, one per floor, sized from the floor's current member nodes so they follow dragging. */
export default function FloorBands({ floors }: { floors: FloorInfo[] }) {
  if (floors.length < 2) return null;
  return <FloorBandsInner floors={floors} />;
}

function FloorBandsInner({ floors }: { floors: FloorInfo[] }) {
  const key = useStore((state) => {
    const parts: number[] = [];
    for (const floor of floors) {
      for (const id of floor.nodeIds) {
        const node = state.nodeLookup.get(id);
        if (!node) { parts.push(NaN, NaN, NaN, NaN); continue; }
        parts.push(node.internals.positionAbsolute.x, node.internals.positionAbsolute.y, node.measured?.width ?? node.width ?? 520, node.measured?.height ?? node.height ?? 320);
      }
      parts.push(-1);
    }
    return parts;
  }, shallow);

  const boxes = useMemo(() => {
    const result: Box[] = [];
    let cursor = 0;
    for (const floor of floors) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
      for (let i = 0; i < floor.nodeIds.length; i++, cursor += 4) {
        const [x, y, w, h] = [key[cursor], key[cursor + 1], key[cursor + 2], key[cursor + 3]];
        if (Number.isNaN(x)) continue;
        count++;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      }
      cursor += 1; // separator
      if (!count) continue;
      const height = Math.max(MIN_HEIGHT, maxY - minY + PAD_TOP + PAD_BOTTOM);
      result.push({ id: floor.id, label: floor.label, count, x: minX - PAD_X, y: minY - PAD_TOP, w: maxX - minX + PAD_X * 2, h: height });
    }
    return result;
  }, [floors, key]);

  if (boxes.length === 0) return null;
  return (
    <ViewportPortal>
      {boxes.map((box) => (
        <div
          key={box.id}
          aria-hidden
          className="floor-band"
          style={{ position: "absolute", transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h, zIndex: -1, pointerEvents: "none" }}
        >
          <div className="floor-band-label">
            <IconGitBranch className="size-4" stroke={2} />
            <span className="truncate">{box.label}</span>
            <span className="floor-band-count">{box.count}</span>
          </div>
        </div>
      ))}
    </ViewportPortal>
  );
}
