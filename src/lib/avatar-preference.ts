import { useSyncExternalStore } from "react";

/** "on" = generated robot avatars for agents (default); "off" = the provider logo. Device-local. */
export type AvatarPreference = "on" | "off";
const KEY = "floq.robotAvatars";
const EVENT = "floq:robot-avatars";
let storageFallback: AvatarPreference | null = null;

function read(): AvatarPreference {
  if (storageFallback) return storageFallback;
  try {
    if (localStorage.getItem(KEY) === "off") return "off";
  } catch { /* Device storage is optional. */ }
  return "on";
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useAvatarPreference() {
  const value = useSyncExternalStore(subscribe, read, () => "on" as const);
  const setValue = (next: AvatarPreference) => {
    try { localStorage.setItem(KEY, next); storageFallback = null; } catch { storageFallback = next; }
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, setValue] as const;
}
