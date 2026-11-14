import { useEffect, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { loadCanvasScroll } from "@/lib/canvas-scroll-pref";
import { newWheelState, pinchFactor, wheelAction, wheelPixels } from "@/lib/wheel-gesture";

/** Figma-style wheel model for a React Flow canvas. Runs in the capture phase on the wrapper and only
 *  takes over touchpad pan and pinch; mouse-wheel / Ctrl+wheel zoom stays with React Flow's own handler.
 *  Anything inside `.nowheel` (terminals, composer, lists) is left alone so it scrolls itself. */
export function useCanvasWheel(ref: RefObject<HTMLElement | null>, minZoom = 0.1, maxZoom = 2) {
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const state = newWheelState();
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.(".react-flow__renderer") || t.closest(".nowheel")) return;
      const action = wheelAction(e, loadCanvasScroll(), state, e.timeStamp || performance.now());
      if (action === "zoom") return;
      e.preventDefault(); e.stopPropagation();
      const v = getViewport();
      if (action === "pan") {
        let { x, y } = wheelPixels(e, el.clientHeight);
        if (e.shiftKey && x === 0) { x = y; y = 0; }
        void setViewport({ x: v.x - x, y: v.y - y, zoom: v.zoom });
        return;
      }
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const zoom = Math.min(maxZoom, Math.max(minZoom, v.zoom * pinchFactor(e.deltaY, e.deltaMode)));
      const k = zoom / v.zoom;
      void setViewport({ x: px - (px - v.x) * k, y: py - (py - v.y) * k, zoom });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [ref, getViewport, setViewport, minZoom, maxZoom]);
}
