import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { IconAlarm, IconClockPlay, IconRobot, IconTrash, IconUser } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ProjectMark } from "@/components/projects/project-identity";
import { markdownToHtml } from "@/lib/markdown-lite";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import {
  PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES, actorSession, formatWhen, fromLocalInput, runOnCopy, taskOrigin, toLocalInput, validateTaskTitle,
  type ProjectTask, type ProjectTaskEvent, type TaskPriority, type TaskStatus,
} from "@/lib/project-tasks";
import { cn } from "cn";
import { projectAgents } from "./task-agents";
import { StatusDot } from "./task-ui";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import type { ProjectTasksData } from "./use-project-tasks";

interface Props { task: ProjectTask | null; onClose: () => void; data: ProjectTasksData; projectLabel: (id: string) => string }

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";
const EVENT_VERB: Record<ProjectTaskEvent["kind"], string> = {
  created: "created the task", status: "changed the status", update: "edited the task", comment: "commented", dispatched: "sent it to an agent", run_failed: "could not start it",
};

export default function TaskSheet({ task, onClose, data, projectLabel }: Props) {
  return (
    <Sheet open={!!task} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl" aria-describedby="task-sheet-desc">
        {task && <Body key={task.id} task={task} onClose={onClose} data={data} projectLabel={projectLabel} />}
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint}
    </div>
  );
}

function Body({ task, onClose, data, projectLabel }: Omit<Props, "task"> & { task: ProjectTask }) {
  const { client, sessions, projects } = useRuntime();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [mode, setMode] = useState<"write" | "read">(task.description.trim() ? "read" : "write");
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [due, setDue] = useState(task.dueAt ? task.dueAt.slice(0, 10) : "");
  const [runOn, setRunOn] = useState(toLocalInput(task.runAt));
  const [assignee, setAssignee] = useState(task.assigneeSessionId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<ProjectTaskEvent[] | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const agents = useMemo(() => projectAgents(sessions, task.projectId), [sessions, task.projectId]);
  const project = projects.find((p) => p.id === task.projectId);
  const origin = taskOrigin(task.createdBy);
  const runIso = fromLocalInput(runOn);
  const dirty = title !== task.title || description !== task.description || status !== task.status || priority !== task.priority || due !== (task.dueAt ? task.dueAt.slice(0, 10) : "")
    || (runIso ?? null) !== task.runAt || (assignee || null) !== task.assigneeSessionId;

  useEffect(() => {
    let live = true;
    client?.projectTaskEvents(task.projectId, task.id).then((e) => { if (live) setEvents(e); }).catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [client, task.projectId, task.id, task.updatedAt]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const t = validateTaskTitle(title);
    if (t) next.title = t;
    if (runOn && !runIso) next.runAt = "Pick a valid date and time.";
    setErrors(next);
    if (Object.keys(next).length || !client || !dirty) return;
    setSaving(true);
    try {
      const saved = await client.updateProjectTask(task.projectId, task.id, {
        title, description, status, priority, assigneeSessionId: assignee || null, runAt: runIso, dueAt: due ? new Date(due + "T12:00:00").toISOString() : null,
      });
      data.setTasks((list) => list.map((x) => (x.id === saved.id ? saved : x)));
      toast.success("Task saved");
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const send = async () => {
    if (!client || !comment.trim() || sending) return;
    setSending(true);
    try { setEvents(await client.commentProjectTask(task.projectId, task.id, comment.trim())); setComment(""); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSending(false); }
  };

  const remove = async () => {
    if (!client) return;
    try { await client.deleteProjectTask(task.projectId, task.id); data.setTasks((l) => l.filter((x) => x.id !== task.id)); setConfirmDelete(false); onClose(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const html = useMemo(() => markdownToHtml(description), [description]);
  return (
    <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.target as HTMLElement).id !== "task-comment") { e.preventDefault(); e.currentTarget.requestSubmit(); } }}>
      <SheetHeader className="border-b px-5 py-3.5 pr-12">
        <SheetTitle className="sr-only">Task details</SheetTitle>
        <SheetDescription id="task-sheet-desc" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">{project && <ProjectMark project={project} className="size-3.5" />}<span className="truncate">{projectLabel(task.projectId)}</span></span>
          {origin.kind === "agent" && <span className="inline-flex items-center gap-1"><IconRobot className="size-3.5" aria-hidden />Created by an agent</span>}
          {origin.kind === "automation" && <span className="inline-flex items-center gap-1"><IconClockPlay className="size-3.5" aria-hidden />Created by an automation</span>}
          <span>Created <time dateTime={task.createdAt}>{formatWhen(task.createdAt)}</time></span>
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-x-8 gap-y-6 px-5 py-6 md:grid-cols-[minmax(0,1fr)_13.5rem]">
          {/* Title */}
          <div className="md:col-start-1 md:row-start-1">
            <label htmlFor="task-title" className="sr-only">Title</label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} aria-describedby={errors.title ? "task-title-err" : undefined}
              className="tasks-doc-title -mx-2 h-auto w-[calc(100%+1rem)] px-2 py-1 text-xl leading-tight font-semibold tracking-tight md:text-xl" />
            {errors.title && <p id="task-title-err" role="alert" className="mt-1 text-xs text-destructive">{errors.title}</p>}
          </div>

          {/* Metadata column */}
          <aside aria-label="Task properties" className="flex flex-col gap-4 md:col-start-2 md:row-span-3 md:row-start-1 md:border-l md:pl-6">
            <Meta label="Status" htmlFor="task-status">
              <div className="relative">
                <StatusDot status={status} className="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2" />
                <NativeSelect id="task-status" className="w-full [&_select]:pl-6" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>{TASK_STATUSES.map((s) => <NativeSelectOption key={s} value={s}>{STATUS_LABEL[s]}</NativeSelectOption>)}</NativeSelect>
              </div>
            </Meta>
            <Meta label="Priority" htmlFor="task-priority">
              <NativeSelect id="task-priority" className="w-full" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>{TASK_PRIORITIES.map((p) => <NativeSelectOption key={p} value={p}>{PRIORITY_LABEL[p]}</NativeSelectOption>)}</NativeSelect>
            </Meta>
            <Meta label="Assigned agent" htmlFor="task-assignee">
              <NativeSelect id="task-assignee" className="w-full" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <NativeSelectOption value="">Project default</NativeSelectOption>
                {agents.map((a) => <NativeSelectOption key={a.id} value={a.id}>{a.title}</NativeSelectOption>)}
                {assignee && !agents.some((a) => a.id === assignee) && <NativeSelectOption value={assignee}>Agent removed</NativeSelectOption>}
              </NativeSelect>
            </Meta>
            <Meta label="Due date" htmlFor="task-due">
              <div className="flex gap-1.5">
                <Input id="task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
                {due && <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-muted-foreground" onClick={() => setDue("")} aria-label="Clear due date">Clear</Button>}
              </div>
            </Meta>
            <Meta label="Run on" htmlFor="task-runon"
              hint={<>
                {errors.runAt && <p role="alert" className="text-xs text-destructive">{errors.runAt}</p>}
                <p id="task-runon-copy" className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground"><IconAlarm aria-hidden className="mt-0.5 size-3.5 shrink-0" />{runOnCopy(runIso)}</p>
              </>}>
              <div className="flex gap-1.5">
                <Input id="task-runon" type="datetime-local" value={runOn} onChange={(e) => setRunOn(e.target.value)} aria-invalid={!!errors.runAt} aria-describedby="task-runon-copy" className="min-w-0" />
                {runOn && <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-muted-foreground" onClick={() => setRunOn("")} aria-label="Clear Run on">Clear</Button>}
              </div>
            </Meta>
          </aside>

          {/* Description */}
          <section aria-labelledby="task-desc-label" className="flex flex-col gap-2 md:col-start-1">
            <div className="flex items-center justify-between gap-2">
              <h3 id="task-desc-label" className="text-sm font-medium">Description</h3>
              <ToggleGroup type="single" size="sm" variant="outline" spacing={0} value={mode} onValueChange={(v) => { if (v === "write" || v === "read") setMode(v); }} aria-label="Description mode">
                <ToggleGroupItem value="write" className="h-7 px-2.5 text-xs">Write</ToggleGroupItem>
                <ToggleGroupItem value="read" className="h-7 px-2.5 text-xs">Preview</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {mode === "read"
              ? html
                ? <article aria-label="Description" className="tasks-prose min-h-24 cursor-text rounded-xl px-1 py-1" onDoubleClick={() => setMode("write")} dangerouslySetInnerHTML={{ __html: html }} />
                : <button type="button" onClick={() => setMode("write")} className="min-h-24 rounded-xl border border-dashed px-3 py-3 text-left text-sm text-muted-foreground hover:bg-[var(--glass-row-hover)]">Add a description. Agents read it before they start.</button>
              : <>
                <label htmlFor="task-desc" className="sr-only">Description (markdown)</label>
                <Textarea id="task-desc" rows={8} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should be done, and how will you know it is done? Markdown works." className="min-h-40 leading-relaxed" />
                <p className="text-xs text-muted-foreground">Markdown: **bold**, lists, `code`, links.</p>
              </>}
          </section>

          {/* Activity */}
          <section aria-labelledby="task-activity-label" className="flex flex-col gap-3 border-t pt-5 md:col-start-1">
            <h3 id="task-activity-label" className="text-sm font-medium">Activity</h3>
            {events === null ? <p className="text-xs text-muted-foreground" role="status">Loading activity…</p> : events.length === 0 ? <p className="text-xs text-muted-foreground">No activity yet.</p> : (
              <ol className="tasks-timeline flex flex-col gap-3">
                {events.map((ev) => {
                  const sid = actorSession(ev.actor);
                  const agent = sid ? sessions.find((s) => s.id === sid) : undefined;
                  const who = sid ? (agent?.title ?? "Agent removed") : ev.actor === "user" ? "You" : "Floq";
                  return (
                    <li key={ev.id} className="flex gap-3 text-sm">
                      <span className="relative z-[1] mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-4 ring-background">
                        {sid ? (agent ? <AgentAvatar session={agent} size={20} /> : <IconRobot className="size-3" />) : ev.actor === "user" ? <IconUser className="size-3" /> : <IconClockPlay className="size-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{who}</span> {EVENT_VERB[ev.kind] ?? ev.kind.replace("_", " ")} <time dateTime={ev.at} className="whitespace-nowrap">{formatWhen(ev.at)}</time></p>
                        {ev.text && <p className={cn("mt-1 break-words whitespace-pre-wrap", ev.kind === "comment" && "rounded-xl bg-muted/60 px-3 py-2", ev.kind === "run_failed" && "text-destructive")}>{ev.text}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="flex flex-col gap-2 rounded-xl border bg-card/60 p-2 focus-within:border-ring/60">
              <label htmlFor="task-comment" className="sr-only">Add a comment</label>
              <Textarea id="task-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a note for the agent or for later"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void send(); } }}
                className="min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent" />
              <div className="flex items-center justify-end gap-2">
                <span className="hidden text-xs text-muted-foreground sm:inline"><Kbd>{MOD}</Kbd> <Kbd>Enter</Kbd></span>
                <Button type="button" variant="secondary" size="sm" disabled={!comment.trim() || sending} onClick={() => void send()}>{sending ? "Sending…" : "Comment"}</Button>
              </div>
            </div>
          </section>
        </div>
      </div>

      <SheetFooter className="flex-row items-center justify-between gap-2 border-t px-5 py-3">
        <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}><IconTrash />Delete</Button>
        <div className="flex items-center gap-2">
          {dirty && <span className="hidden text-xs text-muted-foreground sm:inline">Unsaved changes</span>}
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
          <Button type="submit" size="sm" disabled={!dirty || saving} title={`Save (${MOD}+Enter)`}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </SheetFooter>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this task?</AlertDialogTitle><AlertDialogDescription>“{task.title}” and its activity are removed for good.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
