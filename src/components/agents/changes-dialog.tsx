import { useCallback, useEffect, useMemo, useRef } from "react";
import { IconGitCompare, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FloqSurface } from "@/components/ui/floq-surface";
import { formatChangeCount, setChangesCount, setChangesDialogOpen, takeChangesOpener, useChangesDialog } from "@/lib/changes-dialog";
import { useRuntime } from "@/lib/runtime/store";
import ChangesTab from "./right-sidebar/changes-tab";
import { PanelEmpty } from "./right-sidebar/panel-states";
import { publishGitChanges, useGitChanges } from "./right-sidebar/git-status";
import { usePanelContext } from "./right-sidebar/use-panel-context";

const REFRESH_MS = 45_000;

/**
 * Root-level host for the Changes review dialog, opened from the canvas toolbar or an agent terminal.
 * While closed (canvas only, where the toolbar badge lives) it only fetches the active workspace's change list (no diffs):
 * on workspace change, every 45s while the page is visible, and when one of its agents stops running.
 */
export default function ChangesDialogHost() {
  const { client, sessions } = useRuntime();
  const { open, count } = useChangesDialog();
  const { session, targets, project, view, canvasWorkspace } = usePanelContext();
  const gitChanges = useGitChanges();
  // Workspace ids only: selecting another node of the same workspace must not refetch.
  const signature = targets.map((target) => target.id).join("|");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  // Changes whenever a target's agent starts, sleeps or ends, which is when the working tree has most likely changed.
  const stateKey = targets.map((target) => `${target.id}:${sessions.find((item) => item.id === target.sessionId)?.state ?? ""}`).join("|");
  const watching = !!client && !open && view === "canvas" && targets.length > 0;

  useEffect(() => {
    if (!client || view !== "canvas") return;
    if (targets.length === 0 && !open) setChangesCount(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, view, signature, open]);

  useEffect(() => {
    if (!watching || !client) return;
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      for (const target of targetsRef.current) {
        client.gitChanges(target.sessionId).then((result) => { if (!cancelled) publishGitChanges(target.id, result); }, () => undefined);
      }
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [client, watching, signature, stateKey]);

  const total = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const target of targets) {
      const entry = gitChanges.get(target.id);
      if (entry) { any = true; sum += entry.changes.length; }
    }
    return any ? sum : null;
  }, [targets, gitChanges]);
  useEffect(() => { if (!open && total !== null) setChangesCount(total); }, [total, open]);

  // Keep the last known count while the tab reloads (it reports null until its lists are ready).
  const onCount = useCallback((next: number | null) => { if (next !== null) setChangesCount(next); }, []);
  if (!client) return null;
  const workspaceName = targets.length === 1 ? targets[0].label : project?.name;
  const label = count === null ? "Changes" : `Changes (${formatChangeCount(count)})`;
  return (
    <Dialog open={open} onOpenChange={setChangesDialogOpen}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => { const node = takeChangesOpener(); if (node) { event.preventDefault(); node.focus({ preventScroll: true }); } }}
        className="flex h-[min(860px,90vh)] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
      >
        <FloqSurface className="flex h-12 shrink-0 items-center gap-2 rounded-t-[inherit] rounded-b-none border-b border-border/70 px-3">
          <IconGitCompare className="size-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium leading-none">{label}</DialogTitle>
          {workspaceName && <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground" title={workspaceName}>{workspaceName}</span>}
          <DialogDescription className="sr-only">Review uncommitted changes of {workspaceName ? `the ${workspaceName} workspace` : "this workspace"}</DialogDescription>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)" onClick={() => setChangesDialogOpen(false)}><IconX size={16} /></Button>
        </FloqSurface>
        <div className="min-h-0 flex-1">
          {session
            ? <ChangesTab client={client} targets={targets} onCount={onCount} />
            : <PanelEmpty icon={<IconGitCompare />} title={view === "canvas" && !canvasWorkspace ? "No active workspace" : view === "canvas" ? "No agent in this workspace" : "No agent in this project"} hint={view === "canvas" && !canvasWorkspace ? "Choose a workspace for this project to review its changes." : "Start an agent in this workspace to review its changes."} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
