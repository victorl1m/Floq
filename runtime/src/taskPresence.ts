export interface CursorPresence {
  activeAt: number;
  cursorVisible: boolean;
}

/** Mark stale cursor locations hidden while keeping their websocket subscriptions alive. */
export function expireStaleCursors<T extends CursorPresence>(peers: Iterable<T>, now: number, timeoutMs = 15_000): T[] {
  const expired: T[] = [];
  for (const peer of peers) {
    if (peer.cursorVisible && now - peer.activeAt > timeoutMs) {
      peer.cursorVisible = false;
      expired.push(peer);
    }
  }
  return expired;
}
