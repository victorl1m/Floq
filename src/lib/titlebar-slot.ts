import { useSyncExternalStore } from "react";

// The titlebar exposes an empty area where views can portal their own controls (tabs, toolbars).
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setTitlebarSlot(next: HTMLElement | null) {
    if (slot === next) return;
    slot = next;
    listeners.forEach((listener) => listener());
}

export function useTitlebarSlot(): HTMLElement | null {
    return useSyncExternalStore(
        (callback) => {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },
        () => slot,
        () => null,
    );
}
