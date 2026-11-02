/** Return a split peer only while both sessions remain open, live, and distinct. */
export function resolveSplitPeer(
    primaryId: string | null,
    peerId: string | null,
    liveOpenedIds: ReadonlySet<string>,
): string | null {
    if (!primaryId || !peerId || primaryId === peerId) return null;
    if (!liveOpenedIds.has(primaryId) || !liveOpenedIds.has(peerId)) return null;
    return peerId;
}

/** Accept only an already-open alternate session; comparison never creates or opens a session. */
export function chooseSplitPeer(primaryId: string | null, candidateId: string, openedIds: ReadonlySet<string>): string | null {
    if (!primaryId || candidateId === primaryId || !openedIds.has(candidateId)) return null;
    return candidateId;
}

/** Keep every opened terminal mounted while making exactly the selected pair visible. */
export function visibleSplitIds(openedIds: readonly string[], primaryId: string | null, peerId: string | null): ReadonlySet<string> {
    if (!primaryId || !peerId || primaryId === peerId) return new Set();
    const opened = new Set(openedIds);
    if (!opened.has(primaryId) || !opened.has(peerId)) return new Set();
    return new Set([primaryId, peerId]);
}
