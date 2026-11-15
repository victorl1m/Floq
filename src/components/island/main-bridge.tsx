import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useRuntime } from '@/lib/runtime/store';
import { markApprovalOutcome, removeApproval, useApprovalState } from '@/lib/approvals';
import { useAttentionState } from '@/lib/attention';
import { useNotifications } from '@/components/notifications/notifications-provider';
import { useNotificationAction } from '@/components/notifications/use-notification-action';
import { autoDismisses, notificationAttention, NOTIFICATION_AUTO_DISMISS_MS, capAttention, deferEmptySnapshot, EMPTY_DEFER_AFTER_ANSWER_MS, EMPTY_DEFER_MS, orderAttention, sameSnapshotContent, validAnswers, type AttentionItem, type IslandIntent, type IslandSnapshot } from '@/lib/island-contract';

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
      if (item.kind !== 'notification' || !autoDismisses(item.notification) || dismissTimers.current.has(item.id)) continue;
      dismissTimers.current.set(item.id, setTimeout(() => dismissFromIsland(item.id), NOTIFICATION_AUTO_DISMISS_MS));
    }
  }, [notificationKey]);
  useEffect(() => () => dismissTimers.current.forEach(clearTimeout), []);
  const candidate: IslandSnapshot = { epoch: epoch.current, revision: revision.current, connected: !!client && connected, items: capAttention(queue), busy, error };
  const contentKey = JSON.stringify(candidate, (key, value) => key === 'revision' ? undefined : value);
  const publish = () => invoke('island_publish', { snapshot: latest.current });
  const publishRef = useRef(publish); publishRef.current = publish;
  const intentRef = useRef<(intent: IslandIntent) => void>(() => {});
  intentRef.current = intent => {
    if (intent.type === 'ready') { setReady(true); void publishRef.current().catch(() => setReady(false)); return; }
    if (intent.type === 'notification') {
      const item = latest.current.items.find(i => i.id === intent.id);
      if (!item || item.kind !== 'notification') return;
      if (intent.action === 'open') notificationRefs.current.run(item.notification);
      notificationRefs.current.markRead([item.id]);
      dismissFromIsland(item.id);
      return;
    }
    if (!client || !connected || inflight.current.has(intent.id)) return;
    const item = latest.current.items.find(i => i.id === intent.id);
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
