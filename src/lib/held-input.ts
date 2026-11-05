/**
 * Keystrokes typed while a terminal's stream is reconnecting (runtime restart, network blip) used to be dropped.
 * HeldInput keeps them, in order, and hands them back once the stream is open again.
 *
 * Mouse reports are never held: they carry cell coordinates for a screen that may have changed by the time the
 * stream is back, so replaying a click could pick the wrong option. Input older than maxAgeMs is discarded,
 * because text typed minutes ago into a dead terminal should not suddenly land in a different conversation turn.
 */
export const HELD_INPUT_MAX_CHARS = 16_000;
export const HELD_INPUT_MAX_AGE_MS = 120_000;

const MOUSE_REPORT = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

export function isMouseReport(data: string): boolean {
  return MOUSE_REPORT.test(data);
}

export class HeldInput {
  private chunks: { data: string; at: number }[] = [];
  private chars = 0;
  /** Characters discarded because the buffer was full or too old, since the last take(). */
  dropped = 0;

  private readonly maxChars: number;
  private readonly maxAgeMs: number;

  constructor(maxChars = HELD_INPUT_MAX_CHARS, maxAgeMs = HELD_INPUT_MAX_AGE_MS) {
    this.maxChars = maxChars;
    this.maxAgeMs = maxAgeMs;
  }

  get size(): number {
    return this.chars;
  }

  /** Holds `data`. Returns false when it was not held (mouse report, or no room left). */
  hold(data: string, now = Date.now()): boolean {
    if (!data || isMouseReport(data)) return false;
    this.expire(now);
    if (this.chars + data.length > this.maxChars) {
      this.dropped += data.length;
      return false;
    }
    this.chunks.push({ data, at: now });
    this.chars += data.length;
    return true;
  }

  /** Returns everything still fresh, in typing order, and empties the buffer. */
  take(now = Date.now()): string {
    this.expire(now);
    const out = this.chunks.map((c) => c.data).join("");
    this.chunks = [];
    this.chars = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.chars = 0;
    this.dropped = 0;
  }

  private expire(now: number): void {
    while (this.chunks.length && now - this.chunks[0].at > this.maxAgeMs) {
      const old = this.chunks.shift()!;
      this.chars -= old.data.length;
      this.dropped += old.data.length;
    }
  }
}
