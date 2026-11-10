import { useSyncExternalStore } from "react";

interface ChangesDialogState {
  open: boolean;
  /** Uncommitted file count of the active workspace; null until the first list loads. */
  count: number | null;
}

let state: ChangesDialogState = { open: false, count: null };
const listeners = new Set<() => void>();

function set(patch: Partial<ChangesDialogState>) {
  const next = { ...state, ...patch };
  if (next.open === state.open && next.count === state.count) return;
  state = next;
  listeners.forEach((listener) => listener());
}

export function useChangesDialog(): ChangesDialogState {
  return useSyncExternalStore((callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => state, () => state);
}

let opener: HTMLElement | null = null;

/** Opens the dialog and remembers the focused element so focus can return to it on close. */
export const openChangesDialog = () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  set({ open: true });
};
/** The element that opened the dialog, if it is still attached. */
export const takeChangesOpener = (): HTMLElement | null => {
  const node = opener;
  opener = null;
  return node && node.isConnected ? node : null;
};

/** Shared count label for the toolbar badge and the dialog title. */
export const formatChangeCount = (count: number): string => (count > 99 ? "99+" : String(count));
export const setChangesDialogOpen = (open: boolean) => set({ open });
export const setChangesCount = (count: number | null) => set({ count });
