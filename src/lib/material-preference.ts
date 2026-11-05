import { useSyncExternalStore } from "react";
import { defaultMaterialChoice, useNativeMaterialSupport, type MaterialChoice } from "@/lib/native-material";

export type MaterialPreference = MaterialChoice;
const KEY = "floq.material";
const EVENT = "floq:material";
let storageFallback: MaterialPreference | null = null;

/** The stored choice, or null when none is stored (or it is a retired value: "glass", "system"). */
function read(): MaterialPreference | null {
  if (storageFallback) return storageFallback;
  try {
    const value = localStorage.getItem(KEY);
    if (value === "mica" || value === "acrylic" || value === "solid") return value;
    // Retired values migrate to the platform default.
    if (value !== null) localStorage.removeItem(KEY);
  } catch { /* Device storage is optional. */ }
  return null;
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function subscribeForcedColors(callback: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia("(forced-colors: active)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function readForcedColors() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(forced-colors: active)").matches;
}

export function useForcedColorsPreference() {
  return useSyncExternalStore(subscribeForcedColors, readForcedColors, () => false);
}

/** "mica" | "acrylic" | "solid". Unset defaults to Mica (vibrancy on macOS) where supported, else Solid. */
export function useMaterialPreference() {
  const stored = useSyncExternalStore(subscribe, read, () => null);
  const support = useNativeMaterialSupport();
  const value: MaterialPreference = stored ?? defaultMaterialChoice(support);
  const setValue = (next: MaterialPreference) => {
    try { localStorage.setItem(KEY, next); storageFallback = null; } catch { storageFallback = next; }
    document.documentElement.dataset.material = next;
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, setValue] as const;
}
