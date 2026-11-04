import { useSyncExternalStore } from "react";

/** "custom" = Floq's in-app cursor set; "system" = native cursors. Applies inside the app window only. */
export type CursorPreference = "custom" | "system";
const KEY = "floq.cursors";
const EVENT = "floq:cursors";
let storageFallback: CursorPreference | null = null;

function read(): CursorPreference {
  if (storageFallback) return storageFallback;
  try {
    if (localStorage.getItem(KEY) === "system") return "system";
  } catch { /* Device storage is optional. */ }
  return "custom";
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Call once before first render so the persisted choice never flashes the wrong cursor. */
export function applyCursorPreference() {
  document.documentElement.dataset.cursors = read();
}

export function useCursorPreference() {
  const value = useSyncExternalStore(subscribe, read, () => "custom" as const);
  const setValue = (next: CursorPreference) => {
    try { localStorage.setItem(KEY, next); storageFallback = null; } catch { storageFallback = next; }
    document.documentElement.dataset.cursors = next;
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, setValue] as const;
}
