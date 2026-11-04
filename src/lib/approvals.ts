import { useEffect, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { ApprovalFrame, ApprovalRequest } from "@/lib/runtime/types";
import { newestFirst } from "@/lib/approval-format";

/**
 * Pending approvals the user has to answer. The runtime is authoritative (it enforces the expiry and the single
 * decision); this store only mirrors it, counts down locally, and remembers whether the user deferred the prompt.
 * Nothing here can allow anything by itself: the only path to "allow" is the user's click, which calls the runtime.
 */
export interface ApprovalItem {
  approval: ApprovalRequest;
  deadline: number;
  /** pending: answerable; expired: shown briefly; allowed/denied: the outcome is shown ~1.2s, then the item leaves. */
  state: "pending" | "expired" | "allowed" | "denied";
}

interface State { items: ApprovalItem[]; /** The user pressed Esc: the dialog stays closed (pill + footer chip remain) until a new request arrives. */ deferred: boolean; /** Newest-first index of the card in front. */ index: number }
let state: State = { items: [], deferred: false, index: 0 };
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const EXPIRED_VISIBLE_MS = 5000;
export const OUTCOME_VISIBLE_MS = 1200;

function set(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
export function useApprovalState(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
/** Items newest first. */
export function sortedItems(items: ApprovalItem[]): ApprovalItem[] {
  const order = newestFirst(items.map((i) => ({ createdAt: i.approval.createdAt, i })));
  return order.map((o) => o.i);
}
export const pendingCount = (items: ApprovalItem[]) => items.filter((i) => i.state === "pending").length;
/** For the title bar / document title. */
export function usePendingApprovals(): number {
  return pendingCount(useApprovalState().items);
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export function removeApproval(id: string) {
  clearTimer(id);
  if (!state.items.some((item) => item.approval.id === id)) return;
  const items = state.items.filter((item) => item.approval.id !== id);
  set({ ...state, items, index: Math.min(state.index, Math.max(0, items.length - 1)) });
}

function expireApproval(id: string) {
  clearTimer(id);
  if (!state.items.some((item) => item.approval.id === id && item.state === "pending")) return;
  set({ ...state, items: state.items.map((item) => (item.approval.id === id ? { ...item, state: "expired" } : item)) });
  timers.set(id, setTimeout(() => removeApproval(id), EXPIRED_VISIBLE_MS));
}

/** The user answered: show the outcome briefly, then drop it. */
export function markApprovalOutcome(id: string, outcome: "allowed" | "denied") {
  clearTimer(id);
  set({ ...state, items: state.items.map((item) => (item.approval.id === id ? { ...item, state: outcome } : item)) });
  timers.set(id, setTimeout(() => removeApproval(id), OUTCOME_VISIBLE_MS));
}

export function upsertApproval(approval: ApprovalRequest) {
  const existing = state.items.find((item) => item.approval.id === approval.id);
  if (existing && existing.state !== "pending") return;
  clearTimer(approval.id);
  timers.set(approval.id, setTimeout(() => expireApproval(approval.id), Math.max(0, approval.remainingMs)));
  const item: ApprovalItem = { approval, deadline: Date.now() + approval.remainingMs, state: "pending" };
  if (existing) { set({ ...state, items: state.items.map((i) => (i.approval.id === approval.id ? item : i)) }); return; }
  // A new request always shows itself again, even when an earlier one was deferred.
  set({ items: [...state.items, item], deferred: false, index: 0 });
  attention();
}

export function deferApprovals() { set({ ...state, deferred: true }); }
export function reopenApprovals() { set({ ...state, deferred: false }); }
export function selectApproval(index: number) {
  const count = state.items.length;
  if (count) set({ ...state, index: ((index % count) + count) % count });
}

// ---- attention: taskbar flash while the window is in the background ----

let flashing = false;
function attention() {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  if (!isTauri()) return;
  flashing = true;
  void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => undefined);
}
function clearAttention() {
  if (!flashing || !isTauri()) return;
  flashing = false;
  void getCurrentWindow().requestUserAttention(null).catch(() => undefined);
}

function applyFrame(frame: ApprovalFrame) {
  if (frame.type === "approval-request") upsertApproval(frame.approval);
  else if (frame.type === "approval-resolved") {
    const item = state.items.find((i) => i.approval.id === frame.id);
    // Our own click already set allowed/denied; anything else (expired, cancelled, answered elsewhere) just goes away.
    if (!item || item.state === "allowed" || item.state === "denied") return;
    if (frame.status === "expired" || frame.status === "cancelled") expireApproval(frame.id);
    else removeApproval(frame.id);
  }
}

/** Reconcile with the runtime's list: add what is new and drop what is gone (e.g. answered while disconnected). */
async function refetch(client: RuntimeClient) {
  const approvals = await client.approvals();
  const live = new Set(approvals.map((a) => a.id));
  for (const item of state.items) if (item.state === "pending" && !live.has(item.approval.id)) removeApproval(item.approval.id);
  for (const approval of approvals) upsertApproval(approval);
}

/** Pushed frames on the events socket, a re-fetch on every (re)connect, and a slow poll as a fallback. */
export function useApprovalSync(client: RuntimeClient | null) {
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
          const frame = JSON.parse(String(message.data)) as ApprovalFrame;
          if (frame && (frame.type === "approval-request" || frame.type === "approval-resolved")) applyFrame(frame);
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
    const onFocus = () => clearAttention();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      ws?.close();
      for (const id of [...timers.keys()]) clearTimer(id);
      set({ items: [], deferred: false, index: 0 });
    };
  }, [client]);
}
