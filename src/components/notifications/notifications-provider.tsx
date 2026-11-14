import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { useRuntime } from "@/lib/runtime/store";
import {
  initialNotifications, isNotificationFrame, notificationsReducer, onInjectedNotificationFrame, unreadCount,
  type AppNotification, type NotificationsState,
} from "@/lib/notifications";

type NotificationsValue = {
  items: AppNotification[];
  unread: number;
  loaded: boolean;
  markRead: (ids: string[]) => void;
  markAllRead: () => void;
  clear: (ids: string[] | "all") => void;
};
const NotificationsContext = createContext<NotificationsValue | null>(null);

/** Holds the user's notifications and unread count, fed by the `notification*` frames on the runtime events socket. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const [state, dispatch] = useReducer(notificationsReducer, initialNotifications as NotificationsState);

  useEffect(() => onInjectedNotificationFrame(dispatch), []);

  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const sync = () => { void client.notifications({ limit: 200 }).then((items) => { if (!stopped) dispatch({ type: "snapshot", items }); }).catch(() => undefined); };
    const connect = () => {
      if (stopped) return;
      try { ws = new WebSocket(client.eventsUrl()); } catch { return; }
      ws.onopen = () => { attempt = 0; sync(); };
      ws.onmessage = (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as unknown;
          if (isNotificationFrame(frame)) dispatch(frame);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        ws = null;
        if (!stopped) timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
      };
    };
    sync();
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, [client]);

  // Optimistic: the frame echo from the server is idempotent.
  const markRead = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    dispatch({ type: "local-read", ids, at: new Date().toISOString() });
    void client?.markNotificationsRead(ids).catch(() => undefined);
  }, [client]);
  const markAllRead = useCallback(() => {
    dispatch({ type: "local-read", ids: "all", at: new Date().toISOString() });
    void client?.markNotificationsRead("all").catch(() => undefined);
  }, [client]);
  const clear = useCallback((ids: string[] | "all") => {
    dispatch({ type: "local-clear", ids });
    void client?.clearNotifications(ids).catch(() => undefined);
  }, [client]);

  const value = useMemo<NotificationsValue>(
    () => ({ items: state.items, unread: unreadCount(state.items), loaded: state.loaded, markRead, markAllRead, clear }),
    [state, markRead, markAllRead, clear],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}
