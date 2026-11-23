import type { ApprovalRequest, DecisionView } from './runtime/types';
import type { AppNotification } from './notifications';

export type AttentionItem = { kind: 'approval'; id: string; createdAt: string; approval: ApprovalRequest } | { kind: 'decision'; id: string; createdAt: string; decision: DecisionView } | { kind: 'notification'; id: string; createdAt: string; notification: AppNotification };
/**
 * The audio of a notification. It plays in the main window (which holds the runtime session); the island is its remote control and draws the
 * progress itself between snapshots: while "playing", the position now is `position + (Date.now() - at) / 1000 * rate`.
 */
export interface IslandAudioState { id: string; status: 'loading' | 'playing' | 'paused' | 'error'; position: number; at: number; duration: number | null; rate: number; peaks: number[] | null; error?: string; rev: number }
export type IslandAudioOp = 'play' | 'pause' | 'seek' | 'rate';
export const audioPositionAt = (a: Pick<IslandAudioState, 'status' | 'position' | 'at' | 'duration' | 'rate'>, now: number): number => {
  const t = a.status === 'playing' ? a.position + Math.max(0, now - a.at) / 1000 * a.rate : a.position;
  return Math.max(0, a.duration ? Math.min(a.duration, t) : t);
};
export interface IslandSnapshot { epoch: string; revision: number; connected: boolean; items: AttentionItem[]; busy: string[]; error?: string; audio?: IslandAudioState }
export type IslandIntent = { type: 'ready' } | { type: 'approval'; id: string; decision: 'allow' | 'deny' } | { type: 'decision'; id: string; answers: DecisionAnswer[] } | { type: 'terminal'; id: string} | { type: 'notification'; id: string; action: 'dismiss' | 'open' | 'hold' } | { type: 'notification-action'; id: string; actionId: string; input?: string } | { type: 'notification-audio'; id: string; op: IslandAudioOp; value?: number };
export interface DecisionAnswer { questionId: string; optionIds: string[]; text: string }
const RANK: Record<string, number> = { approval: 0, notification: 2 };
/** Approvals first, then decisions (oldest first), then notifications (newest first): a notification never outranks a request waiting on the user. */
export function orderAttention<T extends {kind: string; createdAt: string; id: string}>(items: T[]): T[] {
  return [...items].sort((a,b) => (RANK[a.kind] ?? 1) - (RANK[b.kind] ?? 1)
    || (a.kind === 'notification' ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt))
    || a.id.localeCompare(b.id));
}
/** At most this many notifications ride in a snapshot. */
export const MAX_NOTIFICATIONS = 5;
/** info/success leave the island on their own after this long (they stay in the Notification Center). */
export const NOTIFICATION_AUTO_DISMISS_MS = 6000;
export const MAX_NOTIFICATION_TITLE_CHARS = 120;
export const MAX_NOTIFICATION_BODY_CHARS = 240;
/** warning and error stay until dismissed (same rule as `persists` in notifications.ts). */
export const autoDismisses = (n: Pick<AppNotification, 'level'>) => n.level === 'info' || n.level === 'success';
/** A plugin message (someone wrote) stays longer than a plain info line; a "hold" intent (the reply field got focus) keeps it until answered or dismissed. */
export const MESSAGE_AUTO_DISMISS_MS = 12000;
export const MAX_REPLY_CHARS = 4000;
export const dismissAfterMs = (n: Pick<AppNotification, 'level' | 'plugin'>): number | null => (n.plugin ? MESSAGE_AUTO_DISMISS_MS : autoDismisses(n) ? NOTIFICATION_AUTO_DISMISS_MS : null);
const AVATAR_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
/** Only an inline image ever reaches an <img> of the island: no remote URL, no SVG. */
export const safeAvatar = (avatar: string | null | undefined): string | null => (typeof avatar === 'string' && avatar.length <= 48_000 && AVATAR_RE.test(avatar) ? avatar : null);
/** Up to two initials of a name, for the avatar fallback. */
/** Up to two initials of a name, for the avatar fallback. A bare phone number gets "#". */
export const initials = (name: string): string => {
  if (!/\p{L}/u.test(name)) return /\d/.test(name) ? '#' : '?';
  const first = (part: string) => /[\p{L}\p{N}]/u.exec(part)?.[0] ?? '';
  const parts = name.trim().split(/\s+/).filter(p => /\p{L}/u.test(p));
  return (first(parts[0]) + (parts.length > 1 ? first(parts[parts.length - 1]) : '')).toUpperCase();
};
/** New unread notifications not already dismissed from the island, newest first, capped. */
export function notificationAttention(notifications: AppNotification[], dismissed: ReadonlySet<string>): Extract<AttentionItem, {kind: 'notification'}>[] {
  return notifications
    .filter(n => !n.readAt && !dismissed.has(n.id))
    .map(n => ({ kind: 'notification' as const, id: n.id, createdAt: n.createdAt, notification: n }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_NOTIFICATIONS);
}
export function acceptSnapshot(current: {epoch:string; revision:number} | null, next: {epoch:string; revision:number}): boolean {
  return !current || current.epoch !== next.epoch || next.revision > current.revision;
}
export function validAnswers(questions: {id:string; options:{id:string}[]; multiSelect:boolean; allowText:boolean}[], answers: DecisionAnswer[]): boolean {
  return answers.some(a => a.optionIds.length > 0 || !!a.text.trim()) && answers.every(a => {
    const q = questions.find(q => q.id === a.questionId);
    return !!q && (q.multiSelect || a.optionIds.length <= 1) && new Set(a.optionIds).size === a.optionIds.length && a.optionIds.every(id => q.options.some(o => o.id === id)) && (q.allowText || !a.text.trim());
  }) && new Set(answers.map(a => a.questionId)).size === answers.length && answers.reduce((n,a) => n+a.text.length,0) <= 8000;
}

export const MAX_ACTION_CHARS = 240;
export const MAX_DETAIL_CHARS = 1200;

/** Cap agent-written text: keep the start and the tail (the end of a long command is where it hides), with an ellipsis between. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${text.slice(0, max - tail - 1)}…${text.slice(text.length - tail)}`;
}

/** The island shows agent-written approval text in a topmost overlay: bound its length (start and tail kept) so it cannot push the real command out of view. */
export function capAttention<T extends { kind: string }>(items: T[]): T[] {
  return items.map((item) => {
    const notification = (item as unknown as { notification?: AppNotification }).notification;
    if (item.kind === 'notification' && notification) {
      const p = notification.plugin;
      const audio = p?.audio ? { audio: { duration: typeof p.audio.duration === 'number' && Number.isFinite(p.audio.duration) && p.audio.duration > 0 ? p.audio.duration : null, waveform: Array.isArray(p.audio.waveform) && p.audio.waveform.length <= 64 && p.audio.waveform.every(v => typeof v === 'number' && Number.isFinite(v)) ? p.audio.waveform.map(v => Math.min(1, Math.max(0, v))) : null } } : {};
      const plugin = p ? { plugin: { ...p, ...audio, name: capText(p.name, 60), subtitle: p.subtitle && capText(p.subtitle, 80), avatar: safeAvatar(p.avatar), actions: p.actions.slice(0, 4).map(a => ({ ...a, label: capText(a.label, 40), ...(a.input ? { input: { placeholder: capText(a.input.placeholder ?? '', 80) } } : {}) })) } } : {};
      return { ...item, notification: { ...notification, title: capText(notification.title, MAX_NOTIFICATION_TITLE_CHARS), body: notification.body && capText(notification.body, MAX_NOTIFICATION_BODY_CHARS), ...plugin } };
    }
    const approval = (item as unknown as { approval?: ApprovalRequest }).approval;
    if (item.kind !== 'approval' || !approval) return item;
    return { ...item, approval: { ...approval, action: capText(approval.action, MAX_ACTION_CHARS), detail: capText(approval.detail, MAX_DETAIL_CHARS) } };
  });
}

export function sameSnapshotContent(a: IslandSnapshot, b: IslandSnapshot): boolean {
  return JSON.stringify({ ...a, revision: 0 }) === JSON.stringify({ ...b, revision: 0 });
}

/** Keep the last queue through brief sync/client teardown gaps. */
export const EMPTY_DEFER_MS = 1500;
/** The island's colored result stays on screen (hold + fade) about 3s; keep the OS window alive a little longer than that after an in-island answer. */
export const EMPTY_DEFER_AFTER_ANSWER_MS = 3300;
export function deferEmptySnapshot(previous: IslandSnapshot | null, next: IslandSnapshot, emptySince: number | null, now: number, holdMs = EMPTY_DEFER_MS): { snapshot: IslandSnapshot; emptySince: number | null } {
  if (next.items.length || !previous?.items.length) return { snapshot: next, emptySince: null };
  const since = emptySince ?? now;
  return { snapshot: now - since < holdMs ? { ...next, items: previous.items } : next, emptySince: since };
}
