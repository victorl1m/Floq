import { useSyncExternalStore } from "react";
import type { WheelMode } from "./wheel-gesture";

/** "auto" tells a touchpad from a mouse wheel per event; "trackpad": scroll pans; "mouse": scroll zooms. */
const KEY = "floq.canvasScroll";
const EVENT = "floq:canvas-scroll";
let fallback: WheelMode | null = null;

export function loadCanvasScroll(): WheelMode {
  if (fallback) return fallback;
  try { const v = localStorage.getItem(KEY); if (v === "trackpad" || v === "mouse") return v; } catch { /* Device storage is optional. */ }
  return "auto";
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb); window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener("storage", cb); };
}

export function useCanvasScroll() {
  const value = useSyncExternalStore(subscribe, loadCanvasScroll, () => "auto" as const);
  const set = (next: WheelMode) => {
    try { localStorage.setItem(KEY, next); fallback = null; } catch { fallback = next; }
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, set] as const;
}
