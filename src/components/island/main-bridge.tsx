import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useRuntime } from '@/lib/runtime/store';
import { markApprovalOutcome, removeApproval, useApprovalState } from '@/lib/approvals';
import { useAttentionState } from '@/lib/attention';
import { useNotifications } from '@/components/notifications/notifications-provider';
import { useNotificationAction } from '@/components/notifications/use-notification-action';
import { NotificationAudio } from './notification-audio';
import { dismissAfterMs, MAX_REPLY_CHARS, notificationAttention, capAttention, deferEmptySnapshot, EMPTY_DEFER_AFTER_ANSWER_MS, EMPTY_DEFER_MS, orderAttention, sameSnapshotContent, validAnswers, type AttentionItem, type IslandAudioState, type IslandIntent, type IslandSnapshot } from '@/lib/island-contract';

export function useIslandBridge() {
  const { client } = useRuntime();
  const { items: approvals } = useApprovalState();
  const { decisions, connected } = useAttentionState();
  const { items: notifications, loaded: notificationsLoaded, markRead } = useNotifications();
  const runNotificationAction = useNotificationAction();
  const notificationRefs = useRef({ markRead, run: runNotificationAction });
  notificationRefs.current = { markRead, run: runNotificationAction };
  /** Ids already present when notifications first loaded (never shown) and ids that arrived since (shown until read or dismissed). */
  const knownNotifications = useRef<Set<string> | null>(null);
  const [liveNotifications, setLiveNotifications] = useState<string[]>([]);
  /** Dismissed from the island (by the user, or auto): they leave the island but auto-dismissed ones stay unread in the Notification Center. */
  const [dismissedNotifications, setDismissedNotifications] = useState<ReadonlySet<string>>(new Set());
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Notifications the user is answering in the island (its reply field got focus): no auto-dismiss any more. */
  const heldNotifications = useRef(new Set<string>());
  /** The audio of a notification plays here, where the runtime session is; the island gets its state in the snapshot. */
  const [audio, setAudio] = useState<IslandAudioState | null>(null);
  const audioEngine = useRef<NotificationAudio | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  useEffect(() => {
    const engine = new NotificationAudio({
      fetch: id => clientRef.current ? clientRef.current.notificationAudio(id) : Promise.reject(Object.assign(new Error('Floq is not connected.'), { status: 0 })),
      played: id => { void clientRef.current?.notificationAudioPlayed(id).catch(() => undefined); },
      publish: setAudio,
    });
    audioEngine.current = engine;
    return () => { audioEngine.current = null; engine.dispose(); setAudio(null); };
  }, []);
  const [ready, setReady] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const inflight = useRef(new Set<string>());
  const epoch = useRef(crypto.randomUUID());
  const revision = useRef(0);
  const latest = useRef<IslandSnapshot>(null!);
  const emptySince = useRef<number | null>(null);
  /** How long an emptied queue is replayed: longer after an in-island answer so the result animation can finish. */
  const emptyHoldMs = useRef(EMPTY_DEFER_MS);
  const queue: AttentionItem[] = orderAttention([
    ...approvals.filter(a => a.state === 'pending').map(a => ({kind:'approval' as const, id:a.approval.id, createdAt:a.approval.createdAt, approval:a.approval})),
    ...decisions.map(d => ({kind:'decision' as const, id:d.id, createdAt:d.createdAt, decision:d})),
    ...notificationAttention(notifications.filter(n => liveNotifications.includes(n.id)), dismissedNotifications),
  ]);
  const notificationKey = queue.filter(i => i.kind === 'notification').map(i => i.id).join(',');
  useEffect(() => {
    if (!notificationsLoaded) return;
    if (knownNotifications.current === null) { knownNotifications.current = new Set(notifications.map(n => n.id)); return; }
    const fresh = notifications.filter(n => !knownNotifications.current!.has(n.id));
    if (!fresh.length) return;
    fresh.forEach(n => knownNotifications.current!.add(n.id));
    setLiveNotifications(old => [...old, ...fresh.filter(n => !n.readAt).map(n => n.id)]);
  }, [notifications, notificationsLoaded]);
  const dismissFromIsland = (id: string) => setDismissedNotifications(old => new Set(old).add(id));
  useEffect(() => {
    for (const item of queue) {
      if (item.kind !== 'notification' || dismissTimers.current.has(item.id) || heldNotifications.current.has(item.id)) continue;
      const after = dismissAfterMs(item.notification);
      if (after === null) continue;
      const id = item.id;
      dismissTimers.current.set(id, setTimeout(() => { if (!heldNotifications.current.has(id)) dismissFromIsland(id); }, after));
    }
  }, [notificationKey]);
  useEffect(() => () => dismissTimers.current.forEach(clearTimeout), []);
  // A notification that left the island (dismissed, read, answered, replaced) stops playing.
  useEffect(() => { audioEngine.current?.retain(new Set(notificationKey ? notificationKey.split(',') : [])); }, [notificationKey]);
  const candidate: IslandSnapshot = { epoch: epoch.current, revision: revision.current, connected: !!client && connected, items: capAttention(queue), busy, error, ...(audio && queue.some(i => i.id === audio.id) ? { audio } : {}) };
  const contentKey = JSON.stringify(candidate, (key, value) => key === 'revision' ? undefined : value);
  const publish = () => invoke('island_publish', { snapshot: latest.current });
  const publishRef = useRef(publish); publishRef.current = publish;
  const intentRef = useRef<(intent: IslandIntent) => void>(() => {});
  intentRef.current = intent => {
    if (intent.type === 'ready') { setReady(true); void publishRef.current().catch(() => setReady(false)); return; }
    if (intent.type === 'notification') {
      const item = latest.current.items.find(i => i.id === intent.id);
      if (!item || item.kind !== 'notification') return;
      if (intent.action === 'hold') { heldNotifications.current.add(item.id); clearTimeout(dismissTimers.current.get(item.id)); return; }
      if (intent.action === 'open') notificationRefs.current.run(item.notification);
      notificationRefs.current.markRead([item.id]);
      dismissFromIsland(item.id);
      return;
    }
    if (intent.type === 'notification-audio') {
      // The island's player. Listening keeps the card (no auto-dismiss) like typing a reply does.
      const item = latest.current.items.find(i => i.id === intent.id);
      const engine = audioEngine.current;
      if (!engine || !item || item.kind !== 'notification' || !item.notification.plugin?.audio) return;
      heldNotifications.current.add(item.id); clearTimeout(dismissTimers.current.get(item.id));
      if (intent.op === 'play') void engine.play(item.id);
      else if (intent.op === 'pause') engine.pause(item.id);
      else if (intent.op === 'seek' && typeof intent.value === 'number') engine.seek(item.id, intent.value);
      else if (intent.op === 'rate' && typeof intent.value === 'number') engine.setRate(item.id, intent.value);
      return;
    }
    if (!client || !connected || inflight.current.has(intent.id)) return;
    const item = latest.current.items.find(i => i.id === intent.id);
    if (intent.type === 'notification-action') {
      // A button of a plugin notification (reply, mark read): the runtime runs that plugin's own route as this user. Only actions the
      // notification itself lists are sent, and text only where the action takes it.
      const action = item?.kind === 'notification' ? item.notification.plugin?.actions.find(a => a.id === intent.actionId) : undefined;
      if (!item || !action) return;
      const input = action.input ? intent.input : undefined;
      if (action.input && (typeof input !== 'string' || !input.trim() || input.length > MAX_REPLY_CHARS)) return;
      heldNotifications.current.add(item.id); clearTimeout(dismissTimers.current.get(item.id));
      emptyHoldMs.current = EMPTY_DEFER_AFTER_ANSWER_MS;
      inflight.current.add(item.id); setBusy([...inflight.current]); setError(undefined);
      void client.notificationAction(item.id, action.id, input).then(() => { notificationRefs.current.markRead([item.id]); dismissFromIsland(item.id); })
        .catch(e => setError(/404/.test(String(e)) ? 'This notification is no longer available.' : String(e instanceof Error ? e.message : e)))
        .finally(() => { inflight.current.delete(item.id); setBusy([...inflight.current]); });
      return;
    }
    if (!item || (intent.type === 'approval' && item.kind !== 'approval') || (intent.type !== 'approval' && item.kind !== 'decision')) return;
    if (intent.type === 'decision' && (item.kind !== 'decision' || item.decision.answerMode === 'terminal' || !validAnswers(item.decision.questions, intent.answers))) return;
    if (intent.type === 'terminal' && (item.kind !== 'decision' || item.decision.source !== 'native')) return;
    if (intent.type !== 'terminal') emptyHoldMs.current = EMPTY_DEFER_AFTER_ANSWER_MS;
    inflight.current.add(intent.id); setBusy([...inflight.current]); setError(undefined);
    const action = intent.type === 'approval' ? client.resolveApproval(intent.id, intent.decision) : intent.type === 'decision' ? client.resolveDecision(intent.id, intent.answers) : client.decisionTerminal(intent.id);
    void action.then(() => { if (intent.type === 'approval') markApprovalOutcome(intent.id, intent.decision === 'allow' ? 'allowed' : 'denied'); }).catch(e => {
      if (/404|409|no longer pending/i.test(String(e))) { if (intent.type === 'approval') removeApproval(intent.id); setError('This request expired or was already answered.'); }
      else setError(String(e));
    }).finally(() => { inflight.current.delete(intent.id); setBusy([...inflight.current]); });
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const update = (event: Event) => setEnabled(!!(event as CustomEvent<{islandEnabled:boolean}>).detail.islandEnabled);
    window.addEventListener('floq:desktop-preferences', update);
    void invoke<{islandEnabled:boolean}>('get_desktop_preferences').then(p => { if (!disposed) setEnabled(p.islandEnabled); }).catch(() => setEnabled(true));
    return () => { disposed = true; window.removeEventListener('floq:desktop-preferences', update); };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    void listen<IslandIntent>('island:intent', event => intentRef.current(event.payload)).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => setReady(false));
    return () => { disposed = true; unlisten?.(); setReady(false); };
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (candidate.items.length) emptyHoldMs.current = EMPTY_DEFER_MS;
      const deferred = deferEmptySnapshot(latest.current, candidate, emptySince.current, Date.now(), emptyHoldMs.current);
      emptySince.current = deferred.emptySince;
      if (!latest.current || !sameSnapshotContent(latest.current, deferred.snapshot)) {
        latest.current = { ...deferred.snapshot, revision: ++revision.current };
        if (ready) void publishRef.current().catch(() => setReady(false));
      }
      if (!candidate.items.length && deferred.snapshot.items.length) {
        timer = setTimeout(update, Math.max(1, emptyHoldMs.current - (Date.now() - emptySince.current!)));
      }
    };
    update();
    return () => clearTimeout(timer);
  }, [contentKey, ready]);
  return ready && enabled;
}
