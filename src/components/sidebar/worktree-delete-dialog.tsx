import { useEffect, useState } from "react";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { RuntimeError } from "@/lib/runtime/client";
import { sessionsForWorkspace } from "@/lib/runtime/projects";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { ProjectWorkspace, RuntimeProject, WorktreeDeleteStatus } from "@/lib/runtime/types";

export interface WorktreeDeleteTarget { project: RuntimeProject; workspace: ProjectWorkspace }

const plural = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

/** Confirmation for deleting a Floq-created worktree. Unsaved work needs a second, explicit confirmation (force). */
export default function WorktreeDeleteDialog({ target, onClose }: { target: WorktreeDeleteTarget | null; onClose: () => void }) {
  const { client, sessions, activeProjectId, activeWorkspaceId, closeTab, selectProject, refreshProjects } = useRuntime();
  const [status, setStatus] = useState<WorktreeDeleteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const projectId = target?.project.id;
  const workspaceId = target?.workspace.id;
  async function load() {
    if (!client || !projectId || !workspaceId) return null;
    const next = await client.worktreeDeleteStatus(projectId, workspaceId);
    setStatus(next);
    return next;
  }
  useEffect(() => {
    setStatus(null);
    setError(null);
    setUnderstood(false);
    setBusy(false);
    if (!target) return;
    let cancelled = false;
    void load().catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workspaceId, client]);

  const risky = !!status && (status.uncommittedFiles > 0 || status.unsavedCommits > 0);
  const liveAgents = status?.sessions.live ?? [];
  const label = status?.branch || target?.workspace.branch || target?.workspace.name || "this worktree";

  async function confirm() {
    if (!client || !target || !status) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.deleteWorktree(target.project.id, target.workspace.id, risky);
      const related = sessionsForWorkspace(target.project.id, target.workspace, sessions);
      for (const session of related) closeTab(session.id);
      if (activeProjectId === target.project.id && activeWorkspaceId === target.workspace.id) {
        const primary = target.project.workspaces.find((workspace) => !workspace.isWorktree && workspace.id !== target.workspace.id);
        selectProject(target.project.id, primary?.id ?? null);
      }
      onClose();
      toast.success(result.alreadyGone ? "Worktree record removed" : "Worktree deleted", {
        description: [result.branchDeleted ? `Deleted local branch ${result.branchDeleted}.` : null, result.branchNote].filter(Boolean).join(" ") || undefined,
      });
      await refreshProjects(true).catch(() => {});
    } catch (cause) {
      setError(errorMessage(cause));
      // The state changed since the dialog opened (new edits, a started agent): show the real numbers again.
      if (cause instanceof RuntimeError && (cause.code === "worktree_has_changes" || cause.code === "worktree_agents_active")) await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  return <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <AlertDialogContent className="sm:max-w-md">
      <AlertDialogHeader>
        <AlertDialogMedia className="bg-destructive/10 text-destructive">{risky ? <IconAlertTriangle /> : <IconTrash />}</AlertDialogMedia>
        <AlertDialogTitle>{risky ? "Discard unsaved work and delete worktree?" : "Delete this worktree?"}</AlertDialogTitle>
        <AlertDialogDescription>
          This removes the worktree folder{status?.floqBranch ? " and its local branch" : ""} from your workspace. The remote repository and your main checkout are not touched.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs" aria-label="Worktree details">
        <dt className="text-muted-foreground">Branch</dt><dd className="min-w-0 break-all font-mono">{label}</dd>
        <dt className="text-muted-foreground">Path</dt><dd className="min-w-0 break-all font-mono">{target?.workspace.cwd}</dd>
        {status ? <>
          <dt className="text-muted-foreground">Uncommitted</dt><dd className={status.uncommittedFiles ? "font-medium text-destructive" : ""}>{status.missing ? "folder already missing" : plural(status.uncommittedFiles, "file")}</dd>
          <dt className="text-muted-foreground">{status.baseBranch ? `Not on ${status.baseBranch}` : "Commits"}</dt><dd>{plural(status.commitsNotOnBase, "commit")}</dd>
          <dt className="text-muted-foreground">Not pushed</dt><dd>{plural(status.unpushedCommits, "commit")}</dd>
          <dt className="text-muted-foreground">Agents</dt><dd>{liveAgents.length ? `${liveAgents.length} running` : "none running"}{status.sessions.idle ? `, ${plural(status.sessions.idle, "sleeping or finished agent")}` : ""}</dd>
        </> : !error && <><dt className="text-muted-foreground">Status</dt><dd>Checking…</dd></>}
      </dl>
      {status && liveAgents.length > 0 && <ErrorBanner>Sleep or delete the running {liveAgents.length === 1 ? "agent" : "agents"} first: {liveAgents.map((agent) => `“${agent.title}”`).join(", ")}.</ErrorBanner>}
      {status && status.sessions.idle > 0 && liveAgents.length === 0 && <p className="text-xs text-muted-foreground">{status.sessions.idle === 1 ? "1 agent in this worktree keeps its history but can" : `${status.sessions.idle} agents in this worktree keep their history but can`} no longer be resumed.</p>}
      {risky && <div role="alert" className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="font-medium text-destructive">This cannot be undone.</p>
        <p>
          {[
            status.uncommittedFiles ? `${plural(status.uncommittedFiles, "uncommitted file")} will be permanently deleted` : null,
            status.unsavedCommits ? `${plural(status.unsavedCommits, "commit")} that exist only on this branch will be lost` : null,
          ].filter(Boolean).join(", and ")}.
        </p>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} /><span>I understand and want to discard this work.</span></label>
      </div>}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy || !status || liveAgents.length > 0 || (risky && !understood)} onClick={(event) => { event.preventDefault(); void confirm(); }}>
          {busy ? "Deleting…" : risky ? "Discard and delete" : "Delete worktree"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
