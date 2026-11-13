// Live agent browser stream (docs/design/agent-browser.md §A.5): reconnecting WebSocket hook + pure input helpers.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeClient } from "./client";
import type { BrowserClientMessage, BrowserFrame, BrowserNav, BrowserServerMessage, BrowserState } from "./browser-types";

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
export const MAX_FRAME = { w: 1600, h: 1200 };
export const FRAME_QUALITY = 60;
const INPUT_PER_SEC = 240;

export interface BrowserStreamState {
  state: BrowserState | "connecting";
  frame: BrowserFrame | null;
  /** The node's single page (set by the `page` message), null until bound. */
  targetId: string | null;
  nav: BrowserNav | null;
  /** Last agent activity on this page (epoch ms), 0 when none. */
  activity: number;
  /** CSS cursor under the pointer in the page. */
  cursor: string;
  agents: number;
  error: string | null;
  /** The page's open alert/confirm/prompt, shown by the node until answered (or the page closes it). */
  dialog: { kind: "alert" | "confirm" | "prompt"; message: string; defaultPrompt: string } | null;
  /** Text the user copied in the page; `seq` changes on every copy so the node writes it to the system clipboard once. */
  clipboard: { text: string; seq: number } | null;
  /** Last download started from this page (files land in ~/Downloads in the sandbox). */
  download: { name: string; state: "started" | "done" | "failed" } | null;
}
const INITIAL: BrowserStreamState = { state: "connecting", frame: null, targetId: null, nav: null, activity: 0, cursor: "default", agents: 0, error: null, dialog: null, clipboard: null, download: null };

const CURSORS = new Set(["default", "pointer", "text", "vertical-text", "grab", "grabbing", "crosshair", "move", "wait", "progress", "help", "not-allowed", "no-drop", "copy", "alias", "context-menu", "cell", "zoom-in", "zoom-out", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize"]);
/** Unknown cursor names fall back to `default` (never feed page-controlled text into CSS). */
export const normalizeCursor = (c: string) => (CURSORS.has(c) ? c : "default");

const CHALLENGE_TITLE = /just a moment|performing security verification|verify(ing)? you are human|attention required|security check/i;
/** True when the page looks like a bot challenge: only used to show a hint, nothing is bypassed. */
export function looksLikeChallenge(title: string | undefined | null, url: string | undefined | null): boolean {
  if (title && CHALLENGE_TITLE.test(title)) return true;
  if (!url) return false;
  let path = url; try { const u = new URL(url); path = u.pathname + u.search; } catch { /* keep raw */ }
  return path.includes("/cdn-cgi/challenge-platform") || path.includes("__cf_chl");
}

/** Applies one runtime message; pure so the e2e and unit checks can share it. */
export function reduceBrowser(prev: BrowserStreamState, msg: BrowserServerMessage): BrowserStreamState {
  switch (msg.type) {
    case "state": return { ...prev, state: msg.state, error: null, ...(msg.state === "running" ? {} : { dialog: null }), ...(msg.state === "running" ? {} : { frame: msg.state === "starting" ? prev.frame : null, ...(msg.state === "starting" ? {} : { targetId: null }) }) };
    case "dialog": return prev.targetId && msg.targetId !== prev.targetId ? prev : { ...prev, dialog: { kind: msg.kind, message: msg.message, defaultPrompt: msg.defaultPrompt } };
    case "dialogClosed": return prev.targetId && msg.targetId !== prev.targetId ? prev : { ...prev, dialog: null };
    case "clipboard": return prev.targetId && msg.targetId !== prev.targetId ? prev : { ...prev, clipboard: { text: msg.text, seq: (prev.clipboard?.seq ?? 0) + 1 } };
    case "download": return prev.targetId && msg.targetId !== prev.targetId ? prev : { ...prev, download: { name: msg.name || prev.download?.name || "file", state: msg.state } };
    case "page": return { ...prev, dialog: null, targetId: msg.targetId, frame: prev.frame?.targetId === msg.targetId ? prev.frame : null, nav: prev.nav?.targetId === msg.targetId ? prev.nav : null };
    case "frame": { if (prev.targetId && msg.targetId !== prev.targetId) return prev; const { type: _t, ...frame } = msg; return { ...prev, frame }; }
    case "nav": { if (prev.targetId && msg.targetId !== prev.targetId) return prev; const { type: _t, ...nav } = msg; return { ...prev, nav }; }
    case "cursor": return { ...prev, cursor: normalizeCursor(msg.cursor) };
    case "agentActivity": return prev.targetId && msg.targetId !== prev.targetId ? prev : { ...prev, activity: msg.at };
    case "clients": return { ...prev, agents: msg.agents };
    case "error": return { ...prev, error: msg.code };
    default: return prev;
  }
}

/**
 * `enabled` false closes the socket (node hidden / closed). The runtime wakes and starts the daemon when a viewer
 * connects, so opening the node is enough. Sends are dropped while disconnected and rate-limited to 240/s.
 */
export function useBrowserStream(client: RuntimeClient | null, enabled: boolean, nodeId: string) {
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
      try { ws = new WebSocket(client.browserStreamUrl(nodeId)); } catch { schedule(); return; }
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
  }, [client, enabled, nodeId, epoch]);

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

/** Like mapPointer but clamps into the shown page (drags that leave the image, final release outside). */
export function mapPointerClamped(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, frame: { w: number; h: number }) {
  if (box.width <= 0 || box.height <= 0 || frame.w <= 0 || frame.h <= 0) return null;
  const k = Math.min(box.width / frame.w, box.height / frame.h);
  const shownW = frame.w * k, shownH = frame.h * k;
  const px = Math.min(shownW, Math.max(0, clientX - box.left - (box.width - shownW) / 2));
  const py = Math.min(shownH, Math.max(0, clientY - box.top - (box.height - shownH) / 2));
  return { x: Math.min(frame.w, Math.round(px / k)), y: Math.min(frame.h, Math.round(py / k)) };
}

/** Wheel delta in pixels: lines*16, pages*viewport height, clamped to +-10000. */
export function wheelPixels(delta: number, deltaMode: number, pageSize: number) {
  const px = deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * pageSize : delta;
  return Math.max(-10000, Math.min(10000, Math.round(px)));
}

/** DOM MouseEvent.button -> CDP name. */
export const buttonName = (b: number) => (b === 1 ? "middle" : b === 2 ? "right" : "left") as "left" | "middle" | "right";

/** Tracks click counts: same button within 500ms and 5px of the previous press -> +1, capped at 3. */
export function createClickCounter() {
  let last: { t: number; x: number; y: number; button: number; n: number } | null = null;
  return (t: number, x: number, y: number, button: number) => {
    const n = last && last.button === button && t - last.t <= 500 && Math.hypot(x - last.x, y - last.y) <= 5 ? Math.min(3, last.n + 1) : 1;
    last = { t, x, y, button, n };
    return n;
  };
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
