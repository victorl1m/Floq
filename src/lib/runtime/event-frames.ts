// Fan-out of the single app-wide /v1/events socket (owned by useApprovalSync) to other consumers, so they need no socket of their own.
type FrameListener = (frame: unknown) => void;
const frameListeners = new Set<FrameListener>();
const connectListeners = new Set<() => void>();

export function publishFrame(frame: unknown): void { for (const fn of [...frameListeners]) { try { fn(frame); } catch { /* a bad listener never breaks the socket */ } } }
export function publishConnect(): void { for (const fn of [...connectListeners]) { try { fn(); } catch { /* ignore */ } } }
/** Every parsed frame of the events socket. Returns the unsubscribe function. */
export function subscribeFrames(fn: FrameListener): () => void { frameListeners.add(fn); return () => { frameListeners.delete(fn); }; }
/** Called on every (re)connect of the events socket; the runtime pushes fresh snapshots right after it. */
export function subscribeConnect(fn: () => void): () => void { connectListeners.add(fn); return () => { connectListeners.delete(fn); }; }
