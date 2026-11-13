// Live agent browser stream (docs/design/agent-browser.md §A.5): reconnecting WebSocket hook + pure input helpers.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeClient } from "./client";
import type { BrowserClientMessage, BrowserFrame, BrowserNav, BrowserServerMessage, BrowserState, BrowserTab } from "./browser-types";

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
export const MAX_FRAME = { w: 1600, h: 1200 };
export const FRAME_QUALITY = 60;
const INPUT_PER_SEC = 120;

export interface BrowserStreamState {
  state: BrowserState | "connecting";
  frame: BrowserFrame | null;
  tabs: BrowserTab[];
  nav: Record<string, BrowserNav>;
  /** targetId -> last agent activity (epoch ms). */
  activity: Record<string, number>;
  agents: number;
  error: string | null;
}
const INITIAL: BrowserStreamState = { state: "connecting", frame: null, tabs: [], nav: {}, activity: {}, agents: 0, error: null };

/** Applies one runtime message; pure so the e2e and unit checks can share it. */
export function reduceBrowser(prev: BrowserStreamState, msg: BrowserServerMessage): BrowserStreamState {
  switch (msg.type) {
    case "state": return { ...prev, state: msg.state, error: null, ...(msg.state === "running" ? {} : { frame: msg.state === "starting" ? prev.frame : null }) };
    case "frame": { const { type: _t, ...frame } = msg; return { ...prev, frame }; }
    case "tabs": return { ...prev, tabs: msg.tabs };
    case "nav": { const { type: _t, ...nav } = msg; return { ...prev, nav: { ...prev.nav, [nav.targetId]: nav } }; }
    case "agentActivity": return { ...prev, activity: { ...prev.activity, [msg.targetId]: msg.at } };
    case "clients": return { ...prev, agents: msg.agents };
    case "error": return { ...prev, error: msg.code };
    default: return prev;
  }
}

/**
 * `enabled` false closes the socket (node hidden / closed). The runtime wakes and starts the daemon when a viewer
 * connects, so opening the node is enough. Sends are dropped while disconnected and rate-limited to 120/s.
 */
export function useBrowserStream(client: RuntimeClient | null, enabled: boolean) {
  const [data, setData] = useState<BrowserStreamState>(INITIAL);
  const wsRef = useRef<WebSocket | null>(null);
  const [epoch, setEpoch] = useState(0);
  const window_ = useRef({ start: 0, count: 0 });

  useEffect(() => {
    if (!client || !enabled) { setData((prev) => (prev.state === "connecting" ? prev : INITIAL)); return; }
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      let ws: WebSocket;
      try { ws = new WebSocket(client.browserStreamUrl()); } catch { schedule(); return; }
      wsRef.current = ws;
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try { const msg = JSON.parse(event.data) as BrowserServerMessage; setData((prev) => reduceBrowser(prev, msg)); } catch { /* ignore malformed */ }
      };
      ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; if (!closed) schedule(); };
      ws.onerror = () => ws.close();
    };
    const schedule = () => {
      setData((prev) => (prev.state === "disabled" || prev.state === "unavailable" ? prev : { ...prev, state: "connecting" }));
      timer = setTimeout(open, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
    };
    open();
    return () => { closed = true; if (timer) clearTimeout(timer); wsRef.current?.close(); wsRef.current = null; };
  }, [client, enabled, epoch]);

  const send = useCallback((msg: BrowserClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - window_.current.start >= 1000) window_.current = { start: now, count: 0 };
    if (msg.type.startsWith("input.") && ++window_.current.count > INPUT_PER_SEC) return;
    ws.send(JSON.stringify(msg));
  }, []);
  const reconnect = useCallback(() => setEpoch((n) => n + 1), []);
  return { ...data, send, reconnect };
}

/** Maps a pointer position over an `object-fit: contain` image back to page coordinates (frame w x h are CSS px). */
export function mapPointer(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, frame: { w: number; h: number }) {
  if (box.width <= 0 || box.height <= 0 || frame.w <= 0 || frame.h <= 0) return null;
  const k = Math.min(box.width / frame.w, box.height / frame.h);
  const shownW = frame.w * k, shownH = frame.h * k;
  const px = clientX - box.left - (box.width - shownW) / 2;
  const py = clientY - box.top - (box.height - shownH) / 2;
  if (px < 0 || py < 0 || px > shownW || py > shownH) return null;
  return { x: Math.round(px / k), y: Math.round(py / k) };
}

/** Bare text becomes https://; explicit http(s) and about:blank pass; anything else (javascript:, file:, ...) is rejected. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (text === "about:blank") return text;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme && !/^[^/]+:\d+(\/|$)/.test(text)) return /^https?$/i.test(scheme[1]) ? text : null;
  return "https://" + text.replace(/^\/\//, "");
}

export const modifierBits = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
