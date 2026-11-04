import { useEffect, useId, useState } from "react";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FOLDERS_PULL_EVENT } from "@/lib/project-folders-cache";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { ProjectDeleteStatus, RuntimeProject } from "@/lib/runtime/types";

const plural = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

/**
 * Irreversible project deletion. The confirmation lists exactly what the runtime will remove (read from
 * GET /v1/projects/:id/delete-status, the same plan DELETE acts on), warns about uncommitted work, and requires the
 * project name to be typed. There is deliberately no Undo.
 */
export default function DeleteProjectDialog({ project, onClose }: { project: RuntimeProject | null; onClose: () => void }) {
  const { client, deleteProject } = useRuntime();
  const [status, setStatus] = useState<ProjectDeleteStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const hintId = useId();

  const projectId = project?.id;
  const name = project ? (project.displayName?.trim() || project.name) : "";

  function load() {
    if (!client || !projectId) return () => {};
    let cancelled = false;
    setStatus(null);
    setStatusError(null);
    client.projectDeleteStatus(projectId)
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch((cause) => { if (!cancelled) setStatusError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }
  useEffect(() => {
    setTyped("");
    setDeleteError(null);
    setBusy(false);
    if (!projectId) { setStatus(null); setStatusError(null); return; }
    return load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, client]);

  const matches = typed.trim() === name && name.length > 0;
  const dirtyWorktrees = status?.dirtyWorktrees ?? 0;
  const anyDirty = dirtyWorktrees > 0 || !!status?.dirtyMainCheckout;
  const worktreeCount = status?.worktrees ?? 0;
  const mainCheckout = status?.checkouts.find((item) => item.kind === "project");

  async function confirm() {
    if (!project || !status || !matches || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      const result = await deleteProject(project.id);
      window.dispatchEvent(new Event(FOLDERS_PULL_EVENT));
      onClose();
      toast.success(`Deleted “${name}”`, {
        description: result.leftovers.length
          ? `${plural(result.leftovers.length, "directory", "directories")} could not be removed from disk and ${result.leftovers.length === 1 ? "was" : "were"} left in place.`
          : undefined,
      });
    } catch (cause) {
      const message = errorMessage(cause);
      setDeleteError(message);
      toast.error("Could not delete the project", { description: message });
    } finally {
      setBusy(false);
    }
  }

  return <AlertDialog open={project !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <AlertDialogContent className="sm:max-w-md" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
      <AlertDialogHeader>
        <AlertDialogMedia className="bg-destructive/10 text-destructive">{anyDirty ? <IconAlertTriangle /> : <IconTrash />}</AlertDialogMedia>
        <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
        <AlertDialogDescription>
          This permanently removes the project from Floq and its files from your runtime. It cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div aria-live="polite" className="flex flex-col gap-3">
        {status ? <>
          <div>
            <p className="mb-1 text-xs font-medium">What will be deleted</p>
            <ul aria-label="What will be deleted" className="flex list-disc flex-col gap-1 rounded-md border border-border bg-muted/30 py-2.5 pr-3 pl-7 text-xs">
              <li>{plural(status.sessions.total, "agent and terminal session")}{status.sessions.live ? `, ${status.sessions.live} running and will be stopped` : ""}</li>
              <li>{plural(status.notes, "canvas note")}, {plural(status.keychains, "keychain")}, links and canvas layout</li>
              <li>
                {mainCheckout?.managed
                  ? <>The project checkout <span className="font-mono break-all">{mainCheckout.path}</span></>
                  : "The project record (its checkout is not managed by Floq)"}
                {worktreeCount > 0 ? <>, and {plural(worktreeCount, "worktree")}</> : null}
              </li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            Not deleted: the original remote repository{status.unmanagedCheckouts > 0 ? `, and ${plural(status.unmanagedCheckouts, "directory", "directories")} outside Floq's project folders` : ""}.
          </p>
          {anyDirty && <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <p className="font-medium text-destructive">Uncommitted changes will be lost</p>
            {dirtyWorktrees > 0 && <p>{plural(dirtyWorktrees, "worktree has", "worktrees have")} uncommitted changes that will be lost.</p>}
            {status.dirtyMainCheckout && <p>The main checkout has {plural(mainCheckout?.uncommittedFiles ?? 0, "uncommitted file")} that will be lost.</p>}
            <p className="text-muted-foreground">Commit and push anything you want to keep first.</p>
          </div>}
          {status.unreadableCheckouts > 0 && <p role="note" className="text-xs text-muted-foreground">{plural(status.unreadableCheckouts, "checkout")} could not be checked for uncommitted changes.</p>}
        </> : statusError
          ? <ErrorBanner>{statusError} <Button type="button" variant="ghost" size="sm" className="ml-1 h-6 px-1.5 text-xs" onClick={() => void load()}>Retry</Button></ErrorBanner>
          : <p role="status" className="text-xs text-muted-foreground">Checking what this project contains…</p>}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId} className="text-xs">Type <span className="font-mono font-semibold">{name}</span> to confirm</Label>
        <Input id={inputId} value={typed} disabled={busy || !status} aria-describedby={hintId} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={(event) => { setTyped(event.target.value); setDeleteError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void confirm(); } }} />
        <p id={hintId} className="text-xs text-muted-foreground">{status ? (matches ? "Name matches." : "The Delete button turns on when the name matches exactly.") : "Waiting for the project details…"}</p>
      </div>

      {deleteError && <ErrorBanner>{deleteError}</ErrorBanner>}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy || !status || !matches} aria-busy={busy} onClick={(event) => { event.preventDefault(); void confirm(); }}>
          {busy ? "Deleting…" : "Delete project"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
