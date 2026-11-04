import { useEffect, useSyncExternalStore } from "react";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { PortRequest, PortRequestFrame } from "@/lib/runtime/types";

/** A request plus the local deadline derived from the runtime's `remainingMs` (no wall-clock sync needed). The runtime stays authoritative. */
export interface PortRequestItem {
  request: PortRequest;
  deadline: number;
  /** "expired" stays visible briefly so the user sees why Allow went away. */
  state: "pending" | "expired";
  /** The user closed the dialog without answering; the request stays reachable from the footer. */
  dismissed: boolean;
}

interface State { items: PortRequestItem[] }
let state: State = { items: [] };
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const EXPIRED_VISIBLE_MS = 5000;

function set(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function usePortRequests(): PortRequestItem[] {
  return useSyncExternalStore((callback) => { listeners.add(callback); return () => listeners.delete(callback); }, () => state, () => state).items;
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export function removePortRequest(id: string) {
  clearTimer(id);
  if (state.items.some((item) => item.request.id === id)) set({ items: state.items.filter((item) => item.request.id !== id) });
}

function expirePortRequest(id: string) {
  clearTimer(id);
  if (!state.items.some((item) => item.request.id === id && item.state === "pending")) return;
  set({ items: state.items.map((item) => (item.request.id === id ? { ...item, state: "expired" } : item)) });
  timers.set(id, setTimeout(() => removePortRequest(id), EXPIRED_VISIBLE_MS));
}

/** Add (or refresh) a request. The local timer is a UI convenience; the runtime's timeout is what ends the request. */
export function upsertPortRequest(request: PortRequest) {
  const existing = state.items.find((item) => item.request.id === request.id);
  if (existing?.state === "expired") return;
  const deadline = Date.now() + request.remainingMs;
  clearTimer(request.id);
  timers.set(request.id, setTimeout(() => expirePortRequest(request.id), Math.max(0, request.remainingMs)));
  const item: PortRequestItem = { request, deadline, state: "pending", dismissed: existing?.dismissed ?? false };
  set({ items: existing ? state.items.map((i) => (i.request.id === request.id ? item : i)) : [...state.items, item] });
}

export function dismissPortRequest(id: string) {
  set({ items: state.items.map((item) => (item.request.id === id ? { ...item, dismissed: true } : item)) });
}

function applyFrame(frame: PortRequestFrame) {
  if (frame.type === "port-request") upsertPortRequest(frame.request);
  else if (frame.type === "port-request-resolved") {
    if (frame.status === "timeout" || frame.status === "cancelled") expirePortRequest(frame.id);
    else removePortRequest(frame.id);
  }
}

/** Reconcile with the runtime's list: add what is new and drop what is gone (e.g. resolved while disconnected). */
async function refetch(client: RuntimeClient) {
  const requests = await client.portRequests();
  const live = new Set(requests.map((request) => request.id));
  for (const item of state.items) if (item.state === "pending" && !live.has(item.request.id)) removePortRequest(item.request.id);
  for (const request of requests) upsertPortRequest(request);
}

/** Keeps the store in sync: pushed frames on the events socket, a re-fetch on every (re)connect, and a slow poll as a fallback. */
export function usePortRequestSync(client: RuntimeClient | null) {
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const sync = () => { void refetch(client).catch(() => undefined); };
    const connect = () => {
      if (stopped) return;
      try { ws = new WebSocket(client.eventsUrl()); } catch { return; }
      ws.onopen = () => { attempt = 0; sync(); };
      ws.onmessage = (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as PortRequestFrame;
          if (frame && (frame.type === "port-request" || frame.type === "port-request-resolved")) applyFrame(frame);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        ws = null;
        if (!stopped) timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
      };
    };
    sync();
    connect();
    const poll = setInterval(() => { if (document.visibilityState !== "hidden") sync(); }, 10_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(poll);
      ws?.close();
      for (const id of [...timers.keys()]) clearTimer(id);
      set({ items: [] });
    };
  }, [client]);
}
