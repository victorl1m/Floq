export const EVENT_MAX_BYTES = 64 * 1024;

export interface PluginEventFrame { type: "plugin"; pluginId: string; name: string; data: unknown }

/** Per-user fan-out for `/v1/events` plugin frames. A frame only ever reaches subscribers of the target user. */
export class PluginEvents {
  private readonly subs = new Set<{ userId: string; fn: (frame: PluginEventFrame) => void }>();

  subscribe(userId: string, fn: (frame: PluginEventFrame) => void): () => void {
    const sub = { userId, fn };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  /** Throws when the payload is not JSON or exceeds 64 KiB; plugin code decides what to do about it. */
  publish(userId: string, pluginId: string, name: string, data: unknown): void {
    if (typeof name !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("event name must be 1-64 letters, digits, . _ -");
    let json: string;
    try { json = JSON.stringify(data ?? null); } catch { throw new Error("event data must be JSON-serializable"); }
    if (Buffer.byteLength(json) > EVENT_MAX_BYTES) throw new Error("event data exceeds 64 KiB");
    const frame: PluginEventFrame = { type: "plugin", pluginId, name, data: JSON.parse(json) };
    for (const sub of this.subs) {
      if (sub.userId !== userId) continue;
      try { sub.fn(frame); } catch { /* a dead socket must not block others */ }
    }
  }
}
