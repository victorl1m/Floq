// Test harness: BOTH halves of the island on one page, joined by the Tauri mock of the spec (island_intent -> "island:intent",
// island_publish -> "island:snapshot"). The main-window half (useIslandBridge) really fetches and plays the audio of a notification; the
// island half (IslandRoot) is the real card with its player. The runtime client is a fake that hands out a generated WAV.
//   ?busy=N   the first N audio fetches fail like a busy WhatsApp server (503)      ?gone=1   the audio is gone (404)
//   ?seconds=N  length of the generated audio (default 8)                            ?slow=MS  the fetch takes this long
import React from "react";
import ReactDOM from "react-dom/client";
import "./font-shim";
import "@/island.css";
import { RuntimeContext } from "@/lib/runtime/store";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { useIslandBridge } from "@/components/island/main-bridge";
import IslandRoot from "@/components/island/island-root";
import { setAttentionConnected } from "@/lib/attention";
import { injectNotificationFrame, type NotificationFrame } from "@/lib/notifications";

const q = new URLSearchParams(location.search);
const w = window as unknown as { __client: Array<{ name: string; args: unknown[] }>; __frame: (f: NotificationFrame) => void };
w.__client = [];
w.__frame = injectNotificationFrame;

/** A mono 16-bit WAV: a tone whose loudness swells, so the decoded waveform has a shape. */
function wav(seconds: number, hz: number): Blob {
  const rate = 8000, n = Math.floor(seconds * rate), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * hz) * (0.15 + 0.85 * Math.abs(Math.sin((i / n) * Math.PI * 5))) * 6000, true);
  return new Blob([buf], { type: "audio/wav" });
}
let busy = Number(q.get("busy")) || 0;
const client = {
  notifications: async () => [],
  markNotificationsRead: async (ids: unknown) => { w.__client.push({ name: "markRead", args: [ids] }); return {}; },
  clearNotifications: async () => ({}),
  eventsUrl: () => "ws://127.0.0.1:9/none",
  notificationAction: async (id: string, actionId: string, input?: string) => { w.__client.push({ name: "notificationAction", args: [id, actionId, input] }); return { ok: true }; },
  notificationAudio: async (id: string) => {
    w.__client.push({ name: "notificationAudio", args: [id] });
    await new Promise((r) => setTimeout(r, Number(q.get("slow")) || 30));
    if (q.get("gone")) throw Object.assign(new Error("This file is no longer available from WAHA."), { status: 404, code: "media_unavailable" });
    if (busy > 0) { busy--; throw Object.assign(new Error("WhatsApp could not hand over this file right now."), { status: 503, code: "media_busy" }); }
    return wav(Number(q.get("seconds")) || 8, 220 + (id.charCodeAt(id.length - 1) % 5) * 60);
  },
  notificationAudioPlayed: async (id: string) => { w.__client.push({ name: "notificationAudioPlayed", args: [id] }); return { ok: true }; },
};
const runtime = { client, loaded: true, sessions: [], projects: [], activeProjectId: null, navigate: () => undefined, openSettings: () => undefined, openSession: () => undefined, focusOnCanvas: () => undefined, openCanvas: () => undefined };
function Bridge() { const ok = useIslandBridge(); return <p data-testid="bridge" hidden>{ok ? "ready" : "off"}</p>; }
setAttentionConnected(true);
ReactDOM.createRoot(document.getElementById("bridge")!).render(<RuntimeContext.Provider value={runtime as never}><NotificationsProvider><Bridge /></NotificationsProvider></RuntimeContext.Provider>);
ReactDOM.createRoot(document.getElementById("root")!).render(<IslandRoot />);
