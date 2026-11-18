import { useEffect, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { loadCanvasScroll } from "@/lib/canvas-scroll-pref";
import { classifyWheel, newGestureLatch, newWheelState, pinchFactor, routeWheel, wheelAction, wheelPixels } from "@/lib/wheel-gesture";

/** Can `from` or an ancestor up to (and including) `boundary` still scroll along the wheel delta? */
function canScrollAlong(from: Element, boundary: Element, dx: number, dy: number): boolean {
  for (let node: Element | null = from; node; node = node.parentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const scrollsY = /(auto|scroll)/.test(style.overflowY) || node instanceof HTMLTextAreaElement;
      const scrollsX = /(auto|scroll)/.test(style.overflowX) || node instanceof HTMLInputElement;
      if (dy !== 0 && scrollsY && node.scrollHeight > node.clientHeight + 1) {
        if (dy < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      }
      if (dx !== 0 && scrollsX && node.scrollWidth > node.clientWidth + 1) {
        if (dx < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
      }
    }
    if (node === boundary) break;
  }
  return false;
}

/** Figma-style wheel model for a React Flow canvas. Runs in the capture phase on the wrapper and takes over
 *  touchpad pan and pinch; mouse-wheel / Ctrl+wheel zoom on empty canvas stays with React Flow's own handler.
 *  Inside `.nowheel` (terminals, composer, inputs, lists) the element keeps the wheel only while it can scroll
 *  (or is marked `data-wheel-owner`); a touchpad gesture stays with whoever started it, and pinch always zooms the canvas. */
export function useCanvasWheel(ref: RefObject<HTMLElement | null>, minZoom = 0.1, maxZoom = 2) {
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const state = newWheelState();
    const latch = newGestureLatch();
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest) return;
      const inRenderer = t.closest(".react-flow__renderer") !== null;
      // Panels (composer, toolbars) sit outside the renderer: only a pinch there is ours, so the page never zooms.
      if (!inRenderer && !(e.ctrlKey || e.metaKey)) return;
      const now = e.timeStamp || performance.now();
      const kind = classifyWheel(e, state, now);
      const boundary = inRenderer ? t.closest(".nowheel") : t;
      const owner = routeWheel(e, kind, {
        inNoWheel: boundary !== null,
        innerOwnsWheel: boundary !== null && t.closest("[data-wheel-owner]") !== null,
        innerCanScroll: boundary !== null && canScrollAlong(t, boundary, e.deltaX, e.deltaY),
      }, latch, now);
      if (owner === "inner") return;
      // classifyWheel already ran for this event: wheelAction re-runs it with the same verdict (sticky state, same timestamp).
      const action = wheelAction(e, loadCanvasScroll(), state, now);
      const v = getViewport();
      if (action === "zoom") {
        // Over empty canvas React Flow zooms itself; over a .nowheel element it would not, so zoom here (never the page).
        if (!boundary) return;
        e.preventDefault(); e.stopPropagation();
        // Touchpad in "mouse" scroll mode zooms smoothly like the empty canvas; a Ctrl+mouse notch zooms one step.
        zoomAt(e, v, kind === "touchpad" ? pinchFactor(e.deltaY, e.deltaMode) : Math.exp(-Math.sign(e.deltaY) * 0.2));
        return;
      }
      e.preventDefault(); e.stopPropagation();
      if (action === "pan") {
        let { x, y } = wheelPixels(e, el.clientHeight);
        if (e.shiftKey && x === 0) { x = y; y = 0; }
        void setViewport({ x: v.x - x, y: v.y - y, zoom: v.zoom });
        return;
      }
      zoomAt(e, v, pinchFactor(e.deltaY, e.deltaMode));
    };
    const zoomAt = (e: WheelEvent, v: { x: number; y: number; zoom: number }, factor: number) => {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const zoom = Math.min(maxZoom, Math.max(minZoom, v.zoom * factor));
      const k = zoom / v.zoom;
      void setViewport({ x: px - (px - v.x) * k, y: py - (py - v.y) * k, zoom });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [ref, getViewport, setViewport, minZoom, maxZoom]);
}
