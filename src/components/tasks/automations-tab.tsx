import { useEffect, useState } from "react";
import { IconAlertTriangle, IconClockPlay, IconDots, IconPencil, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LoadingState } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { describeSchedule, formatWhen, lastStatusLabel, relativeWhen, type ProjectAutomation } from "@/lib/project-tasks";
import { cn } from "cn";
import AutomationEditor from "./automation-editor";
import { typingTarget } from "./task-ui";
import type { ProjectTasksData } from "./use-project-tasks";

interface Props { data: ProjectTasksData; projectId: string | null; projectLabel: (id: string) => string }

export default function AutomationsTab({ data, projectId, projectLabel }: Props) {
  const { client, projects } = useRuntime();
  const [editing, setEditing] = useState<ProjectAutomation | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProjectAutomation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canCreate = projects.length > 0;

  // N: new automation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "n" || e.key === "N") && !e.shiftKey && canCreate && !typingTarget(e)) { e.preventDefault(); setEditing("new"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canCreate]);

  const run = async (label: string, id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); await data.reload(); if (label) toast.success(label); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const toggle = (a: ProjectAutomation, enabled: boolean) => run("", a.id, () => client!.updateAutomation(a.projectId, a.id, { enabled }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 pb-4 sm:px-8">
        <p className="max-w-prose text-sm text-muted-foreground">Each run adds a task to the project. Schedule it once, or every few days, weeks, months or years.</p>
        <Button size="sm" shimmer onClick={() => setEditing("new")} disabled={!canCreate} className="h-8" title="New automation (N)">
          <IconPlus />New automation<Kbd className="ml-1 hidden sm:inline-flex">N</Kbd>
        </Button>
      </div>
      {data.error && <div className="px-4 pb-3 sm:px-8"><ErrorBanner>{data.error}<Button className="ml-3 h-7" size="sm" variant="outline" onClick={() => void data.reload()}>Retry</Button></ErrorBanner></div>}
      {data.loading ? (
        <LoadingState label="Loading automations…" className="min-h-48 px-4 sm:px-8" />
      ) : data.automations.length === 0 && !data.error ? (
        <Empty className="mx-auto mt-[6vh] mb-auto max-w-md border-0">
          <EmptyHeader><EmptyMedia variant="icon"><IconClockPlay /></EmptyMedia><EmptyTitle>No automations yet</EmptyTitle>
            <EmptyDescription>Put recurring work on a schedule, like “every month on day 19 at 09:00, prepare the billing report”. Each run adds a task for the project’s agent.</EmptyDescription></EmptyHeader>
          <EmptyContent><Button size="sm" onClick={() => setEditing("new")} disabled={!canCreate}><IconPlus />Create an automation</Button></EmptyContent>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-8">
          <ul aria-label="Automations" className="settings-group material-content mx-auto max-w-[960px] divide-y divide-border rounded-2xl">
            {data.automations.map((a) => {
              const failed = !!a.lastStatus?.startsWith("error");
              const next = a.enabled && a.nextRunAt;
              return (
                <li key={a.id} className={cn("tasks-row flex flex-wrap items-center gap-x-4 gap-y-3 px-4! py-3.5! sm:flex-nowrap sm:px-[18px]!", !a.enabled && "text-muted-foreground")}>
                  <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", a.enabled ? "bg-primary/10 text-primary-text" : "bg-muted text-muted-foreground")}>
                    <IconClockPlay className="size-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex min-w-0 items-center gap-2">
                      <button type="button" onClick={() => setEditing(a)} className="min-w-0 truncate rounded-sm text-left text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{a.title}</button>
                      {!projectId && <Badge variant="outline" className="max-w-32 truncate">{projectLabel(a.projectId)}</Badge>}
                      {!a.enabled && <Badge variant="secondary">Paused</Badge>}
                    </div>
                    <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{describeSchedule(a.schedule)}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {next
                        ? <span className="font-medium text-foreground">Next run {relativeWhen(a.nextRunAt!)} <time dateTime={a.nextRunAt!} className="font-normal text-muted-foreground">({formatWhen(a.nextRunAt!)})</time></span>
                        : <span>{a.enabled ? "Finished: no more runs" : "Paused: no runs scheduled"}</span>}
                      <span className={cn("inline-flex items-center gap-1", failed && "text-destructive")}>
                        {failed && <IconAlertTriangle aria-hidden className="size-3.5" />}
                        {lastStatusLabel(a.lastStatus)}{a.lastRunAt && <> <time dateTime={a.lastRunAt}>{relativeWhen(a.lastRunAt)}</time></>}
                      </span>
                      {a.runCount > 0 && <span>{a.runCount} {a.runCount === 1 ? "run" : "runs"} so far</span>}
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Switch checked={a.enabled} disabled={busy === a.id} aria-label={`${a.enabled ? "Pause" : "Enable"} ${a.title}`} onCheckedChange={(v) => void toggle(a, v)} />
                    <Button variant="outline" size="sm" disabled={busy === a.id} onClick={() => void run("Task created", a.id, () => client!.runAutomation(a.projectId, a.id))}><IconPlayerPlay />Run now</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${a.title}`}><IconDots /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-36">
                        <DropdownMenuItem onSelect={() => setEditing(a)}><IconPencil />Edit</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(a)}><IconTrash />Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <AutomationEditor open={editing !== null} onClose={() => setEditing(null)} automation={editing === "new" ? null : editing} projectId={projectId} projects={projects.map((p) => ({ id: p.id, label: projectLabel(p.id) }))} onSaved={() => void data.reload()} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle><AlertDialogDescription>It stops running. Tasks it already created stay.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { const a = deleting!; setDeleting(null); void run("Automation deleted", a.id, () => client!.deleteAutomation(a.projectId, a.id)); }}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
