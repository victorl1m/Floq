import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_GRACE_MS, PendingDeletes, describeBatch, type PendingBatch, type PendingItem } from "./undo-delete";
import type { SessionSummary } from "./runtime/types";

interface Options {
  /** Really delete one session (and clean local state). 404 must resolve. */
  performDelete: (id: string) => Promise<void>;
  /** Keepalive delete used on pagehide. */
  sendOnUnload: (id: string) => void;
  /** Whether a client is available (recovery of persisted deletes waits for it). */
  signedIn: boolean;
  /** Unfiltered session list, used to tell whether a session ended by itself during the grace period. */
  allSessions: SessionSummary[];
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm, [role='dialog'], [role='alertdialog'], [role='menu']")) return true;
  return false;
}

/**
 * Soft delete with Undo for sessions (terminals and agents). The registry is the single source
 * of `pendingDeleteIds`; the store filters every list with it. See ./undo-delete.ts for lifecycle.
 */
export function useUndoDelete({ performDelete, sendOnUnload, signedIn, allSessions }: Options) {
  const performRef = useRef(performDelete);
  performRef.current = performDelete;
  const unloadRef = useRef(sendOnUnload);
  unloadRef.current = sendOnUnload;
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  const [announcement, setAnnouncement] = useState("");

  const [registry] = useState(() => new PendingDeletes({
    graceMs: DEFAULT_GRACE_MS,
    finalize: (id) => performRef.current(id),
    sendOnUnload: (id) => unloadRef.current(id),
    onFailed: (item, error) => {
      toast.error(`Could not delete ${item.label}`, { description: error instanceof Error ? error.message : String(error) });
    },
  }));
  const [pendingDeleteIds, setPendingDeleteIds] = useState<ReadonlySet<string>>(() => registry.pendingIds());
  useEffect(() => {
    const sync = () => setPendingDeleteIds(registry.pendingIds());
    sync();
    return registry.subscribe(sync);
  }, [registry]);

  const undoBatch = useCallback((key?: string) => {
    const items = registry.undo(key);
    if (items.length === 0) return;
    const ended = items.filter((item) => !sessionsRef.current.some((session) => session.id === item.id));
    if (ended.length > 0) {
      const kind = describeBatch(ended).noun;
      toast.error(ended.length === 1 ? `${kind[0].toUpperCase()}${kind.slice(1)} already ended` : `${ended.length} ${kind}s already ended`, {
        description: "It finished on its own, so it cannot be restored.",
      });
    }
    const restored = items.length - ended.length;
    if (restored > 0) setAnnouncement(restored === 1 ? `${describeBatch(items).noun[0].toUpperCase()}${describeBatch(items).noun.slice(1)} restored` : `${restored} restored`);
  }, [registry]);

  const showToast = useCallback((batch: PendingBatch) => {
    const { title } = describeBatch(batch.items);
    toast(title, {
      id: batch.key,
      duration: Math.max(1000, batch.deadline - Date.now()),
      action: { label: "Undo", onClick: () => undoBatch(batch.key) },
      onDismiss: () => { void registry.dismiss(batch.key); },
      onAutoClose: () => { void registry.dismiss(batch.key); },
    });
    setAnnouncement(`${title.replace(/ deleted$/, "")} deleted. Undo available`);
  }, [registry, undoBatch]);

  const deleteSessions = useCallback((sessions: Pick<SessionSummary, "id" | "title" | "provider">[]) => {
    const items: PendingItem[] = sessions.map((session) => ({
      id: session.id,
      label: session.title || (session.provider === "shell" ? "Terminal" : "Agent"),
      kind: session.provider === "shell" ? "terminal" : "agent",
    }));
    const batch = registry.schedule(items);
    if (batch) showToast(batch);
  }, [registry, showToast]);

  // Ctrl/Cmd+Z restores the latest deletion unless the user is typing or inside a terminal/dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
      const latest = registry.latest();
      if (!latest) return;
      event.preventDefault();
      undoBatch(latest.key);
      toast.dismiss(latest.key); // after the undo: its onDismiss then finds nothing to finalise
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [registry, undoBatch]);

  // Closing or reloading the page inside the grace period finalises the deletes (keepalive).
  useEffect(() => {
    const onPageHide = () => registry.flushAll();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [registry]);

  // Deletes left behind by a previous page load are finished once we can talk to the runtime.
  useEffect(() => {
    if (signedIn) void registry.recover();
  }, [registry, signedIn]);

  return { pendingDeleteIds, deleteSessions, undoLastDelete: () => undoBatch(), announcement };
}
