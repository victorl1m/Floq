import { useState } from "react";
import { IconClockPlay, IconPencil, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { describeSchedule, formatWhen, lastStatusLabel, type ProjectAutomation } from "@/lib/project-tasks";
import AutomationEditor from "./automation-editor";
import type { ProjectTasksData } from "./use-project-tasks";

interface Props { data: ProjectTasksData; projectId: string | null; projectLabel: (id: string) => string }

export default function AutomationsTab({ data, projectId, projectLabel }: Props) {
  const { client, projects } = useRuntime();
  const [editing, setEditing] = useState<ProjectAutomation | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProjectAutomation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); await data.reload(); if (label) toast.success(label); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const toggle = (a: ProjectAutomation, enabled: boolean) => run("", a.id, () => client!.updateAutomation(a.projectId, a.id, { enabled }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-3 sm:px-5">
        <p className="text-sm text-muted-foreground">Create tasks on a schedule: once, or every few days, weeks, months or years.</p>
        <Button size="sm" onClick={() => setEditing("new")} disabled={projects.length === 0}><IconPlus />New automation</Button>
      </div>
      {data.error && <div className="px-3 pb-2 sm:px-5"><ErrorBanner>{data.error}<Button className="ml-3 h-7" size="sm" variant="outline" onClick={() => void data.reload()}>Retry</Button></ErrorBanner></div>}
      {data.loading ? (
        <div role="status" aria-busy="true" aria-label="Loading automations" className="space-y-2 px-3 sm:px-5">{[0, 1, 2].map((i) => <Skeleton key={i} rows={1} className="h-20 w-full rounded-xl" />)}</div>
      ) : data.automations.length === 0 ? (
        <Empty className="m-auto max-w-md border-0">
          <EmptyHeader><EmptyMedia variant="icon"><IconClockPlay /></EmptyMedia><EmptyTitle>No automations yet</EmptyTitle>
            <EmptyDescription>For example: “Every month on day 19 at 09:00, prepare the billing report.” Each run adds a task for the project’s agent.</EmptyDescription></EmptyHeader>
          <EmptyContent><Button size="sm" onClick={() => setEditing("new")} disabled={projects.length === 0}><IconPlus />New automation</Button></EmptyContent>
        </Empty>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4 sm:px-5" aria-label="Automations">
          {data.automations.map((a) => (
            <li key={a.id} className="glass-surface flex flex-wrap items-start gap-3 rounded-xl border border-border/70 p-3.5">
              <div className="min-w-0 flex-1 basis-64 space-y-1">
                <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-sm font-medium">{a.title}</h2>{!projectId && <Badge variant="outline">{projectLabel(a.projectId)}</Badge>}{!a.enabled && <Badge variant="secondary">Paused</Badge>}</div>
                <p className="text-sm text-muted-foreground">{describeSchedule(a.schedule)}</p>
                <p className="text-xs text-muted-foreground">
                  {a.enabled ? (a.nextRunAt ? <>Next run <time dateTime={a.nextRunAt}>{formatWhen(a.nextRunAt)}</time></> : "Finished: no more runs") : "Paused: no runs scheduled"}
                  {" · "}{lastStatusLabel(a.lastStatus)}{a.lastRunAt && <> (<time dateTime={a.lastRunAt}>{formatWhen(a.lastRunAt)}</time>)</>}{a.runCount > 0 && ` · ${a.runCount} ${a.runCount === 1 ? "run" : "runs"}`}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch checked={a.enabled} disabled={busy === a.id} aria-label={`${a.enabled ? "Pause" : "Enable"} ${a.title}`} onCheckedChange={(v) => void toggle(a, v)} />
                <Button variant="outline" size="sm" disabled={busy === a.id} onClick={() => void run("Task created", a.id, () => client!.runAutomation(a.projectId, a.id))}><IconPlayerPlay />Run now</Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${a.title}`} onClick={() => setEditing(a)}><IconPencil /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${a.title}`} onClick={() => setDeleting(a)}><IconTrash /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <AutomationEditor open={editing !== null} onClose={() => setEditing(null)} automation={editing === "new" ? null : editing} projectId={projectId} projects={projects.map((p) => ({ id: p.id, label: projectLabel(p.id) }))} onSaved={() => void data.reload()} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle><AlertDialogDescription>It stops running. Tasks it already created stay.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { const a = deleting!; setDeleting(null); void run("Automation deleted", a.id, () => client!.deleteAutomation(a.projectId, a.id)); }}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
