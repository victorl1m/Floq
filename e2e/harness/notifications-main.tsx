// Test harness: bell + Notification Center + toaster with mock frames. ?theme=dark, ?seed=1 (preloaded list), ?width=N
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { NotificationToaster } from "@/components/notifications/notification-toaster";
import { NotificationBell } from "@/components/notifications/notification-center";
import { injectNotificationFrame, type AppNotification, type NotificationFrame } from "@/lib/notifications";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as { __calls: Array<{ name: string; args: unknown }>; __frame: (f: NotificationFrame) => void };
w.__calls = [];
w.__frame = injectNotificationFrame;
const rec = (name: string) => (...args: unknown[]) => { w.__calls.push({ name, args }); };

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const mk = (id: string, level: AppNotification["level"], category: AppNotification["category"], title: string, extra: Partial<AppNotification> = {}): AppNotification => ({
  id, userId: "u1", projectId: "p1", sessionId: "s1", sessionName: "Build agent", level, category, title, body: null, action: null, createdAt: ago(1), readAt: null, ...extra,
});
const seed: AppNotification[] = q.get("seed") ? [
  mk("a", "error", "build", "Release build failed on windows-latest", { body: "Step 'tauri build' exited with code 1. See the log for the linker error.", action: { kind: "url", target: "https://example.test/run/1", label: "Open log" }, createdAt: ago(3) }),
  mk("b", "success", "release", "v1.0.13 published", { sessionName: "Release agent", createdAt: ago(42) }),
  mk("c", "warning", "cost", "Usage at 80% of the weekly limit", { projectId: "p2", action: { kind: "settings", target: "accounts", label: "Open Settings" }, createdAt: ago(190) }),
  mk("d", "info", "agent", "Docs agent finished the API reference", { readAt: ago(10), action: { kind: "agent", target: "s1", label: "Open agent" }, createdAt: ago(60 * 26) }),
  mk("e", "info", "system", "Runtime updated", { sessionId: null, sessionName: null, projectId: null, readAt: ago(10), createdAt: ago(60 * 24 * 4) }),
] : [];

const client = {
  notifications: async () => seed,
  markNotificationsRead: async (ids: unknown) => { w.__calls.push({ name: "markRead", args: [ids] }); return {}; },
  clearNotifications: async (ids: unknown) => { w.__calls.push({ name: "clear", args: [ids] }); return {}; },
  eventsUrl: () => "ws://127.0.0.1:9/none",
};
const runtime = {
  client, loaded: true, sessions: [{ id: "s1", provider: "claude", projectId: "p1", state: "idle" }],
  projects: [{ id: "p1", name: "Floq App" }, { id: "p2", name: "Website" }], activeProjectId: "p1",
  openSettings: rec("openSettings"), openSession: rec("openSession"), focusOnCanvas: rec("focusOnCanvas"), openCanvas: rec("openCanvas"),
};
const realOpen = window.open;
window.open = ((url?: string | URL) => { w.__calls.push({ name: "open", args: [String(url)] }); return null; }) as typeof realOpen;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeContext.Provider value={runtime as never}>
    <TooltipProvider>
      <NotificationsProvider>
        <div className="flex h-10 items-center justify-end border-b bg-background px-3 text-foreground glass-surface"><NotificationBell /></div>
        <NotificationToaster />
        <Toaster />
      </NotificationsProvider>
    </TooltipProvider>
  </RuntimeContext.Provider>,
);
