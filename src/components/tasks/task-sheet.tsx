import { useEffect, useMemo, useState, type FormEvent } from "react";
import { IconAlarm, IconClockPlay, IconRobot, IconTrash, IconUser } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { markdownToHtml } from "@/lib/markdown-lite";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import {
  PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES, actorSession, formatWhen, fromLocalInput, runOnCopy, taskOrigin, toLocalInput, validateTaskTitle,
  type ProjectTask, type ProjectTaskEvent, type TaskPriority, type TaskStatus,
} from "@/lib/project-tasks";
import { projectAgents } from "./task-agents";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import type { ProjectTasksData } from "./use-project-tasks";

interface Props { task: ProjectTask | null; onClose: () => void; data: ProjectTasksData; projectLabel: (id: string) => string }

export default function TaskSheet({ task, onClose, data, projectLabel }: Props) {
  return (
    <Sheet open={!!task} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-lg" aria-describedby="task-sheet-desc">
        {task && <Body key={task.id} task={task} onClose={onClose} data={data} projectLabel={projectLabel} />}
      </SheetContent>
    </Sheet>
  );
}

function Body({ task, onClose, data, projectLabel }: Omit<Props, "task"> & { task: ProjectTask }) {
  const { client, sessions } = useRuntime();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [due, setDue] = useState(task.dueAt ? task.dueAt.slice(0, 10) : "");
  const [runOn, setRunOn] = useState(toLocalInput(task.runAt));
  const [assignee, setAssignee] = useState(task.assigneeSessionId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<ProjectTaskEvent[] | null>(null);
  const [comment, setComment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const agents = useMemo(() => projectAgents(sessions, task.projectId), [sessions, task.projectId]);
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
    if (Object.keys(next).length || !client) return;
    setSaving(true);
    try {
      const saved = await client.updateProjectTask(task.projectId, task.id, {
        title, description, status, priority, assigneeSessionId: assignee || null, runAt: runIso, dueAt: due ? new Date(due + "T12:00:00").toISOString() : null,
      });
      data.setTasks((list) => list.map((x) => (x.id === saved.id ? saved : x)));
      toast.success("Task saved");
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!client || !comment.trim()) return;
    try { setEvents(await client.commentProjectTask(task.projectId, task.id, comment.trim())); setComment(""); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const remove = async () => {
    if (!client) return;
    try { await client.deleteProjectTask(task.projectId, task.id); data.setTasks((l) => l.filter((x) => x.id !== task.id)); setConfirmDelete(false); onClose(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const html = useMemo(() => markdownToHtml(description), [description]);
  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" noValidate>
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="sr-only">Task details</SheetTitle>
        <SheetDescription id="task-sheet-desc" className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{projectLabel(task.projectId)}</Badge>
          {origin.kind === "agent" && <Badge variant="secondary"><IconRobot />Created by an agent</Badge>}
          {origin.kind === "automation" && <Badge variant="secondary"><IconClockPlay />Created by an automation</Badge>}
          <span>Created {formatWhen(task.createdAt)}</span>
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="space-y-1.5">
          <Label htmlFor="task-title">Title</Label>
          <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} aria-describedby={errors.title ? "task-title-err" : undefined} />
          {errors.title && <p id="task-title-err" role="alert" className="text-xs text-destructive">{errors.title}</p>}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="task-desc">Description <span className="font-normal text-muted-foreground">(markdown)</span></Label>
            <Button type="button" size="xs" variant="ghost" onClick={() => setPreview((v) => !v)}>{preview ? "Edit" : "Preview"}</Button>
          </div>
          {preview
            ? <article aria-label="Description preview" className="min-h-24 space-y-2 rounded-lg border bg-background/45 p-3 text-sm leading-6 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: html || "<p class='text-muted-foreground'>Nothing here yet.</p>" }} />
            : <Textarea id="task-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should be done? Agents read this." />}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="task-status">Status</Label>
            <NativeSelect id="task-status" className="w-full" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>{TASK_STATUSES.map((s) => <NativeSelectOption key={s} value={s}>{STATUS_LABEL[s]}</NativeSelectOption>)}</NativeSelect></div>
          <div className="space-y-1.5"><Label htmlFor="task-priority">Priority</Label>
            <NativeSelect id="task-priority" className="w-full" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>{TASK_PRIORITIES.map((p) => <NativeSelectOption key={p} value={p}>{PRIORITY_LABEL[p]}</NativeSelectOption>)}</NativeSelect></div>
          <div className="space-y-1.5"><Label htmlFor="task-due">Due date</Label>
            <Input id="task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="task-assignee">Assigned agent</Label>
            <NativeSelect id="task-assignee" className="w-full" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <NativeSelectOption value="">Project default</NativeSelectOption>
              {agents.map((a) => <NativeSelectOption key={a.id} value={a.id}>{a.title}</NativeSelectOption>)}
              {assignee && !agents.some((a) => a.id === assignee) && <NativeSelectOption value={assignee}>Agent removed</NativeSelectOption>}
            </NativeSelect></div>
        </div>
        <fieldset className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 p-3">
          <legend className="flex items-center gap-1.5 px-1 text-sm font-medium"><IconAlarm className="size-4" aria-hidden />Run on</legend>
          <div className="flex gap-2">
            <Input aria-label="Run on date and time" type="datetime-local" value={runOn} onChange={(e) => setRunOn(e.target.value)} aria-invalid={!!errors.runAt} aria-describedby="task-runon-copy" />
            {runOn && <Button type="button" variant="outline" size="sm" onClick={() => setRunOn("")}>Clear</Button>}
          </div>
          {errors.runAt && <p role="alert" className="text-xs text-destructive">{errors.runAt}</p>}
          <p id="task-runon-copy" className="text-xs text-muted-foreground">{runOnCopy(runIso)}</p>
        </fieldset>
        <section aria-label="Activity" className="space-y-3">
          <h3 className="text-sm font-medium">Activity</h3>
          {events === null ? <p className="text-xs text-muted-foreground" role="status">Loading activity…</p> : events.length === 0 ? <p className="text-xs text-muted-foreground">No activity yet.</p> : (
            <ol className="space-y-3">
              {events.map((ev) => {
                const sid = actorSession(ev.actor);
                const agent = sid ? sessions.find((s) => s.id === sid) : undefined;
                return <li key={ev.id} className="flex gap-2.5 text-sm">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">{sid ? (agent ? <AgentAvatar session={agent} size={20} /> : <IconRobot className="size-3" />) : ev.actor === "user" ? <IconUser className="size-3" /> : <IconClockPlay className="size-3" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">{sid ? (agent?.title ?? "Agent removed") : ev.actor === "user" ? "You" : "System"}</span><span>{ev.kind.replace("_", " ")}</span><time dateTime={ev.at}>{formatWhen(ev.at)}</time></div>
                    {ev.text && <p className={`whitespace-pre-wrap break-words ${ev.kind === "run_failed" ? "text-destructive" : ""}`}>{ev.text}</p>}
                  </div>
                </li>;
              })}
            </ol>
          )}
          <div className="flex gap-2">
            <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Add a comment" placeholder="Add a comment for the agent or your future self" />
            <Button type="button" variant="outline" size="sm" disabled={!comment.trim()} onClick={(e) => void send(e as unknown as FormEvent)}>Comment</Button>
          </div>
        </section>
      </div>
      <SheetFooter className="flex-row items-center justify-between border-t">
        <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}><IconTrash />Delete</Button>
        <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button><Button type="submit" size="sm" disabled={!dirty || saving}>{saving ? "Saving…" : "Save"}</Button></div>
      </SheetFooter>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this task?</AlertDialogTitle><AlertDialogDescription>“{task.title}” and its activity are removed for good.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
