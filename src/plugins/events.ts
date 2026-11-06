// Plugin frames arriving on the runtime's `/v1/events` socket. Pure and dependency-free so it runs under plain node tests.
export interface PluginEventFrame { type: "plugin"; pluginId: string; name: string; data: unknown }

type Listener = (data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const key = (pluginId: string, name: string) => pluginId + "\u0000" + name;

type ToastListener = (toast: { pluginId: string; title: string; description?: string }) => void;
const toastListeners = new Set<ToastListener>();

/** Plugins raise toasts with `ctx.toast`, a `toast` event. The host shows them on any screen. */
export function subscribePluginToasts(fn: ToastListener): () => void {
  toastListeners.add(fn);
  return () => { toastListeners.delete(fn); };
}

export function isPluginFrame(value: unknown): value is PluginEventFrame {
  const f = value as Partial<PluginEventFrame> | null;
  return !!f && f.type === "plugin" && typeof f.pluginId === "string" && typeof f.name === "string";
}

/** Called by the socket owner for every frame; non-plugin frames are ignored. A throwing listener never blocks the others. */
export function dispatchPluginFrame(frame: unknown): void {
  if (!isPluginFrame(frame)) return;
  if (frame.name === "toast") {
    const d = frame.data as { title?: unknown; description?: unknown } | null;
    if (d && typeof d.title === "string" && d.title) for (const fn of [...toastListeners]) fn({ pluginId: frame.pluginId, title: d.title.slice(0, 120), description: typeof d.description === "string" && d.description ? d.description.slice(0, 300) : undefined });
  }
  for (const fn of [...(listeners.get(key(frame.pluginId, frame.name)) ?? [])]) {
    try { fn(frame.data); } catch (error) { console.error("Plugin event listener failed", frame.pluginId, frame.name, error); }
  }
}

export function subscribePluginEvent(pluginId: string, name: string, fn: Listener): () => void {
  const k = key(pluginId, name);
  const set = listeners.get(k) ?? new Set<Listener>();
  set.add(fn); listeners.set(k, set);
  return () => { set.delete(fn); if (!set.size) listeners.delete(k); };
}
