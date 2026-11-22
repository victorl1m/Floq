// Test harness: the MAIN-window half of the island (useIslandBridge) with Tauri mocked by the spec. It publishes snapshots through
// island_publish and receives island:intent events; the runtime client is a fake that records calls. ?fail=1 makes the action call fail.
import React from "react";
import ReactDOM from "react-dom/client";
import { RuntimeContext } from "@/lib/runtime/store";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { useIslandBridge } from "@/components/island/main-bridge";
import { setAttentionConnected } from "@/lib/attention";
import { injectNotificationFrame, type NotificationFrame } from "@/lib/notifications";

const q = new URLSearchParams(location.search);
const w = window as unknown as { __client: Array<{ name: string; args: unknown[] }>; __nav: unknown[][]; __frame: (f: NotificationFrame) => void; __release?: () => void };
w.__client = []; w.__nav = [];
w.__frame = injectNotificationFrame;
const client = {
  notifications: async () => [],
  markNotificationsRead: async (ids: unknown) => { w.__client.push({ name: "markRead", args: [ids] }); return {}; },
  clearNotifications: async () => ({}),
  eventsUrl: () => "ws://127.0.0.1:9/none",
  notificationAction: (id: string, actionId: string, input?: string) => {
    w.__client.push({ name: "notificationAction", args: [id, actionId, input] });
    // The spec decides when the runtime answers, so the "busy" snapshot can be observed.
    return new Promise((resolve, reject) => { w.__release = () => (q.get("fail") ? reject(new Error("WhatsApp is not connected.")) : resolve({ ok: true })); });
  },
};
const runtime = {
  client, loaded: true, sessions: [], projects: [], activeProjectId: null,
  navigate: (...args: unknown[]) => { w.__nav.push(args); }, openSettings: () => undefined, openSession: () => undefined, focusOnCanvas: () => undefined, openCanvas: () => undefined,
};
function Bridge() { const ok = useIslandBridge(); return <p data-testid="bridge">{ok ? "ready" : "off"}</p>; }
setAttentionConnected(true);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeContext.Provider value={runtime as never}><NotificationsProvider><Bridge /></NotificationsProvider></RuntimeContext.Provider>,
);
