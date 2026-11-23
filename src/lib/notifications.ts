/** Notification model shared with the runtime (docs/design/notifications.md). One-way: no waiter, no response. */
export type NotificationLevel = "info" | "success" | "warning" | "error";
export type NotificationCategory = "release" | "build" | "agent" | "cost" | "security" | "message" | "system" | "custom";
export type NotificationAction = { kind: "url" | "canvas" | "agent" | "settings"; target: string; label: string };
/** The part a plugin attached (runtime `ctx.notify`): a message card with the plugin's own actions. */
export type NotificationPlugin = {
  id: string; name: string; icon: string | null; kind: "message"; subtitle: string | null; avatar: string | null; tag: string | null;
  actions: { id: string; label: string; input?: { placeholder: string } }[];
  target: { view: string; params: Record<string, string> } | null;
  /** An audio attachment (a voice note): seconds and bar heights (0 to 1) when the plugin knows them. The bytes come from the runtime. */
  audio?: { duration: number | null; waveform: number[] | null };
};
export type AppNotification = {
  id: string;
  userId: string;
  projectId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  level: NotificationLevel;
  category: NotificationCategory;
  title: string;
  body: string | null;
  action: NotificationAction | null;
  createdAt: string;
  readAt: string | null;
  plugin?: NotificationPlugin;
};
export type NotificationFrame =
  | { type: "notification"; notification: AppNotification }
  | { type: "notification-read"; ids: string[] | "all" }
  | { type: "notification-cleared"; ids: string[] | "all" };

export const LEVELS: NotificationLevel[] = ["info", "success", "warning", "error"];
export const CATEGORIES: NotificationCategory[] = ["release", "build", "agent", "cost", "security", "message", "system", "custom"];
export const MAX_KEPT = 500;

export type NotificationsState = { items: AppNotification[]; loaded: boolean };
export const initialNotifications: NotificationsState = { items: [], loaded: false };

const newestFirst = (a: AppNotification, b: AppNotification) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

export function isNotificationFrame(frame: unknown): frame is NotificationFrame {
  const type = (frame as { type?: unknown } | null)?.type;
  return type === "notification" || type === "notification-read" || type === "notification-cleared";
}

export type NotificationEvent = NotificationFrame | { type: "snapshot"; items: AppNotification[] } | { type: "local-read"; ids: string[] | "all"; at: string } | { type: "local-clear"; ids: string[] | "all" };

export function notificationsReducer(state: NotificationsState, event: NotificationEvent): NotificationsState {
  const pick = (ids: string[] | "all") => (ids === "all" ? () => true : ((set) => (n: AppNotification) => set.has(n.id))(new Set(ids)));
  switch (event.type) {
    case "snapshot": {
      const known = new Map(event.items.map((n) => [n.id, n]));
      // Keep arrivals that raced the fetch.
      for (const n of state.items) if (!known.has(n.id)) known.set(n.id, n);
      return { loaded: true, items: [...known.values()].sort(newestFirst).slice(0, MAX_KEPT) };
    }
    case "notification": {
      const n = event.notification;
      const rest = state.items.filter((item) => item.id !== n.id);
      return { ...state, items: [n, ...rest].sort(newestFirst).slice(0, MAX_KEPT) };
    }
    case "notification-read":
    case "local-read": {
      const match = pick(event.ids);
      const at = "at" in event ? event.at : new Date().toISOString();
      return { ...state, items: state.items.map((n) => (match(n) && !n.readAt ? { ...n, readAt: at } : n)) };
    }
    case "notification-cleared":
    case "local-clear": {
      const match = pick(event.ids);
      return { ...state, items: state.items.filter((n) => !match(n)) };
    }
  }
}

export const unreadCount = (items: AppNotification[]) => items.reduce((count, n) => count + (n.readAt ? 0 : 1), 0);

/** Frames injected without a socket (tests and harnesses). The provider listens to this alongside its socket. */
const listeners = new Set<(frame: NotificationFrame) => void>();
export const onInjectedNotificationFrame = (fn: (frame: NotificationFrame) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const injectNotificationFrame = (frame: NotificationFrame) => { for (const fn of listeners) fn(frame); };

export type NotificationFilters = { level: NotificationLevel | "all"; category: NotificationCategory | "all"; project: string | "all" };
export const noFilters: NotificationFilters = { level: "all", category: "all", project: "all" };
export const applyFilters = (items: AppNotification[], f: NotificationFilters) =>
  items.filter((n) => (f.level === "all" || n.level === f.level) && (f.category === "all" || n.category === f.category) && (f.project === "all" || (n.projectId ?? "none") === f.project));

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
export function groupByDay(items: AppNotification[], now = new Date()): { label: string; items: AppNotification[] }[] {
  const groups: { label: string; items: AppNotification[] }[] = [];
  for (const n of items) {
    const label = dayLabel(n.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
/** warning and error stay until dismissed; info and success go away on their own. */
export const persists = (level: NotificationLevel) => level === "warning" || level === "error";
