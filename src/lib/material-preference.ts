import { useSyncExternalStore } from "react";

export type MaterialPreference = "glass" | "system" | "solid";
const KEY = "floq.material";
const EVENT = "floq:material";
let storageFallback: MaterialPreference | null = null;

function read(): MaterialPreference {
  if (storageFallback) return storageFallback;
  try {
    const value = localStorage.getItem(KEY);
    if (value === "solid" || value === "system" || value === "glass") return value;
  } catch { /* Device storage is optional. */ }
  // Default is the cheap path: Glisse refraction on every button is opt-in ("glass").
  return "system";
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

export function useMaterialPreference() {
  const value = useSyncExternalStore(subscribe, read, () => "system" as const);
  const setValue = (next: MaterialPreference) => {
    try { localStorage.setItem(KEY, next); storageFallback = null; } catch { storageFallback = next; }
    document.documentElement.dataset.material = next;
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, setValue] as const;
}
