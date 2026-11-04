import { useSyncExternalStore } from "react";

export type MaterialPreference = "glass" | "system" | "solid";
const KEY = "floq.material";
const EVENT = "floq:material";
let storageFallback: MaterialPreference | null = null;

function read(): MaterialPreference {
  if (storageFallback) return storageFallback;
  try {
    const value = localStorage.getItem(KEY);
    if (value === "solid" || value === "system") return value;
  } catch { /* Device storage is optional. */ }
  return "glass";
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useMaterialPreference() {
  const value = useSyncExternalStore(subscribe, read, () => "glass" as const);
  const setValue = (next: MaterialPreference) => {
    try { localStorage.setItem(KEY, next); storageFallback = null; } catch { storageFallback = next; }
    document.documentElement.dataset.material = next;
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, setValue] as const;
}
