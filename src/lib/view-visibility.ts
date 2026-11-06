// Pure view rules shared by App and the history/transition logic. Relative imports only (runs under plain node tests).
export type AppView = "home" | "tasks" | "skills" | "secrets" | "canvas" | "terminal" | "session" | "plugin";

/** Plugin view ids look like `<pluginId>/<viewId>`. */
export const PLUGIN_VIEW_ARG = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/**
 * The terminal panel is always mounted (xterm scrollback must survive navigation) and only hidden while another screen is in front.
 * It shows for the terminal and agent-session views; every other view, including plugin views, hides it.
 */
export const isTerminalHidden = (view: AppView): boolean => view !== "terminal" && view !== "session";

/** Views that cross-fade through the view-transition API: the simple full-page views and plugin pages. */
export const isSimpleView = (view: AppView): boolean => view === "home" || view === "tasks" || view === "skills" || view === "secrets" || view === "plugin";

export const canTransitionViewChange = (from: AppView, to: AppView): boolean => from !== to && isSimpleView(from) && isSimpleView(to);

// ---- Navigation history (the store keeps a stack of entries; these are its pure operations) ----

export interface HistoryEntry { view: AppView; arg: string | null }
export interface HistoryState { stack: HistoryEntry[]; index: number }

/** Entry for a plugin view, or null when the id is not `<pluginId>/<viewId>`. */
export const pluginEntry = (arg: unknown): HistoryEntry | null => (typeof arg === "string" && PLUGIN_VIEW_ARG.test(arg) ? { view: "plugin", arg } : null);

/** Pushes an entry after the current one (dropping forward history). Returns null when it equals the current entry. */
export function pushEntry(h: HistoryState, entry: HistoryEntry): HistoryState | null {
  const current = h.stack[h.index];
  if (current.view === entry.view && current.arg === entry.arg) return null;
  const stack = [...h.stack.slice(0, h.index + 1), entry];
  return { stack, index: stack.length - 1 };
}

/** Moves back (-1) or forward (+1). Returns null at the ends. */
export function moveEntry(h: HistoryState, delta: number): { state: HistoryState; entry: HistoryEntry } | null {
  const index = h.index + delta;
  if (index < 0 || index >= h.stack.length) return null;
  return { state: { ...h, index }, entry: h.stack[index] };
}
