// When a conversation should ask for fresh delivery ticks: it has a message of ours, sent in the last 24 hours, that is not read yet.
import type { Message } from "./chat.js";

export const ACK_REFRESH_EVERY_MS = 30_000;
const WINDOW_MS = 24 * 3600_000;
export function needsAckRefresh(messages: readonly Pick<Message, "fromMe" | "ack" | "sentAt" | "pending" | "failed" | "deleted">[] | null | undefined, now: number): boolean {
  return !!messages?.some((m) => {
    if (!m.fromMe || m.pending || m.failed || m.deleted) return false;
    const ack = m.ack ?? 1, at = Date.parse(m.sentAt);
    return ack >= 0 && ack < 3 && Number.isFinite(at) && now - at < WINDOW_MS && at <= now + 60_000;
  });
}
