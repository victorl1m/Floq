import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { IconAlarm, IconArrowsMove, IconCalendarEvent, IconClockPlay, IconLayoutKanban, IconList, IconPlus, IconRobot } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import {
  BOARD_STATUSES, PRIORITY_LABEL, STATUS_LABEL, dropPosition, formatDay, formatWhen, groupByStatus, isOverdue, sortTasks, taskOrigin, validateTaskTitle,
  type ProjectTask, type TaskStatus,
} from "@/lib/project-tasks";
import { AgentLabel } from "./task-agents";
import TaskSheet from "./task-sheet";
import type { ProjectTasksData } from "./use-project-tasks";

const PRIORITY_DOT: Record<string, string> = { urgent: "bg-red-500", high: "bg-amber-500", normal: "bg-sky-500/70", low: "bg-muted-foreground/40" };
const VIEW_KEY = "floq.tasks.view.v1";
const readView = (): "board" | "list" => { try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"; } catch { return "board"; } };

interface Props { data: ProjectTasksData; projectId: string | null; projectLabel: (id: string) => string; autoOn: boolean; target: string | null }

export default function TasksTab({ data, projectId, projectLabel, autoOn, target }: Props) {
  const { client, sessions } = useRuntime();
  const [view, setView] = useState(readView);
  const [title, setTitle] = useState("");
  const [quickProject, setQuickProject] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropStatus, setDropStatus] = useState<TaskStatus | null>(null);
  const { projects } = useRuntime();
  const effectiveProject = projectId ?? (quickProject || projects[0]?.id || "");
  const groups = useMemo(() => groupByStatus(data.tasks), [data.tasks]);
  const open = data.tasks.find((t) => t.id === openId) ?? null;
  const agentOf = (id: string | null) => (id ? sessions.find((s) => s.id === id) : undefined);
  const hiddenCount = data.tasks.filter((t) => t.status === "cancelled").length;

  const changeView = (v: string) => { if (v !== "board" && v !== "list") return; setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* optional */ } };

  const patch = async (task: ProjectTask, body: Partial<ProjectTask>) => {
    if (!client) return;
    data.setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, ...body } : t)));
    try { const saved = await client.updateProjectTask(task.projectId, task.id, body); data.setTasks((list) => list.map((t) => (t.id === saved.id ? saved : t))); }
    catch (e) { toast.error(errorMessage(e)); void data.reload(); }
  };
  const move = (task: ProjectTask, status: TaskStatus, index?: number) => {
    const column = sortTasks(data.tasks).filter((t) => t.status === status && t.id !== task.id);
    void patch(task, { status, position: dropPosition(column, index ?? column.length) });
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateTaskTitle(title);
    setTitleError(err);
    if (err || !client || !effectiveProject) return;
    try {
      const task = await client.createProjectTask(effectiveProject, { title: title.trim() });
      data.setTasks((list) => [...list, task]);
      setTitle("");
    } catch (e2) { setTitleError(errorMessage(e2)); }
  };

  const onDrop = (event: DragEvent, status: TaskStatus) => {
    event.preventDefault();
    const task = data.tasks.find((t) => t.id === dragId);
    setDragId(null); setDropStatus(null);
    if (!task) return;
    const column = groups[status].filter((t) => t.id !== task.id);
    const cards = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-task-id]")).filter((el) => el.dataset.taskId !== task.id);
    let index = column.length;
    cards.forEach((el, i) => { const r = el.getBoundingClientRect(); if (index === column.length && event.clientY < r.top + r.height / 2) index = i; });
    move(task, status, index);
  };

  const card = (task: ProjectTask, compact = false) => {
    const origin = taskOrigin(task.createdBy);
    const waiting = task.status === "todo" && task.runAt && Date.parse(task.runAt) > Date.now();
    const assignee = agentOf(task.assigneeSessionId);
    return (
      <div key={task.id} data-task-id={task.id} draggable onDragStart={(e) => { setDragId(task.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", task.id); }} onDragEnd={() => { setDragId(null); setDropStatus(null); }}
        className={`group glass-surface relative rounded-lg border border-border/60 p-3 text-left transition-colors hover:border-border ${dragId === task.id ? "opacity-50" : ""} ${compact ? "flex items-center gap-3" : "space-y-2"}`}>
        <button type="button" onClick={() => setOpenId(task.id)} className="absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open task: ${task.title}`} />
        <div className="pointer-events-none flex min-w-0 flex-1 items-start gap-2">
          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`} title={`${PRIORITY_LABEL[task.priority]} priority`} />
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-medium leading-snug ${compact ? "truncate" : "line-clamp-3"} ${task.status === "done" ? "text-muted-foreground line-through" : ""}`}>{task.title}</p>
            {!compact && task.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description.replace(/[#*`>_-]/g, "")}</p>}
          </div>
        </div>
        <div className={`pointer-events-none flex flex-wrap items-center gap-1.5 ${compact ? "justify-end" : ""}`}>
          {!projectId && <Badge variant="outline" className="max-w-28 truncate">{projectLabel(task.projectId)}</Badge>}
          {compact && <Badge variant="secondary">{STATUS_LABEL[task.status]}</Badge>}
          {origin.kind === "agent" && <Badge variant="secondary"><IconRobot />Agent</Badge>}
          {origin.kind === "automation" && <Badge variant="secondary"><IconClockPlay />Automation</Badge>}
          {waiting && <Badge variant="outline" title={`Agents start this only on ${formatWhen(task.runAt!)}`}><IconAlarm />{formatWhen(task.runAt!)}</Badge>}
          {task.dueAt && <Badge variant={isOverdue(task) ? "destructive" : "outline"}><IconCalendarEvent />{formatDay(task.dueAt)}</Badge>}
          {assignee && <span className="text-xs text-muted-foreground"><AgentLabel session={assignee} size={14} /></span>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" className="relative z-10 shrink-0 self-start opacity-60 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Move “${task.title}” to another column`}><IconArrowsMove /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {BOARD_STATUSES.filter((s) => s !== task.status).map((s) => <DropdownMenuItem key={s} onSelect={() => move(task, s)}>{STATUS_LABEL[s]}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start gap-2 px-3 py-3 sm:px-5">
        <form onSubmit={add} className="flex min-w-0 flex-1 basis-72 flex-wrap items-start gap-2" noValidate>
          {!projectId && projects.length > 0 && <NativeSelect aria-label="Project for the new task" value={effectiveProject} onChange={(e) => setQuickProject(e.target.value)} className="w-auto max-w-44">
            {projects.map((p) => <NativeSelectOption key={p.id} value={p.id}>{projectLabel(p.id)}</NativeSelectOption>)}
          </NativeSelect>}
          <div className="min-w-0 flex-1 basis-56">
            <Input value={title} onChange={(e) => { setTitle(e.target.value); setTitleError(null); }} placeholder="Add a task and press Enter" aria-label="New task title" aria-invalid={!!titleError} aria-describedby={titleError ? "task-title-error" : undefined} maxLength={220} />
            {titleError && <p id="task-title-error" role="alert" className="mt-1 text-xs text-destructive">{titleError}</p>}
          </div>
          <Button type="submit" size="sm" disabled={!effectiveProject}><IconPlus />Add</Button>
        </form>
        <ToggleGroup type="single" value={view} onValueChange={changeView} variant="outline" size="sm" aria-label="Task layout">
          <ToggleGroupItem value="board" aria-label="Board view"><IconLayoutKanban /></ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="Compact list view"><IconList /></ToggleGroupItem>
        </ToggleGroup>
      </div>
      {data.error && <div className="px-3 pb-2 sm:px-5"><ErrorBanner>{data.error}<Button className="ml-3 h-7" size="sm" variant="outline" onClick={() => void data.reload()}>Retry</Button></ErrorBanner></div>}
      {data.loading ? (
        <div role="status" aria-busy="true" aria-label="Loading tasks" className="flex min-h-0 flex-1 gap-3 overflow-hidden px-3 sm:px-5">
          {[3, 2, 1, 1].map((n, i) => <div key={i} className="w-72 shrink-0 space-y-2 rounded-xl border border-border/70 bg-muted/20 p-2.5">{Array.from({ length: n }, (_, j) => <Skeleton key={j} rows={1} className="h-16 w-full rounded-lg" />)}</div>)}
        </div>
      ) : data.tasks.length === 0 ? (
        <Empty className="m-auto max-w-md border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><IconRobot /></EmptyMedia>
            <EmptyTitle>No tasks yet</EmptyTitle>
            <EmptyDescription>Add a task above. Turn on “Agents work on tasks” and the project’s agent picks it up and reports back here. Use “Run on” to start it only on a chosen day.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-3 pb-4 sm:px-5" role="list" aria-label="Task columns">
          {BOARD_STATUSES.map((status) => (
            <section key={status} role="listitem" aria-label={STATUS_LABEL[status]} onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropStatus(status); } }} onDragLeave={() => setDropStatus((s) => (s === status ? null : s))} onDrop={(e) => onDrop(e, status)}
              className={`flex max-h-full w-[min(19rem,84vw)] shrink-0 flex-col rounded-xl border bg-muted/20 transition-colors ${dropStatus === status ? "border-primary/60 bg-primary/5" : "border-border/70"}`}>
              <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-3">
                <h2 className="text-sm font-medium">{STATUS_LABEL[status]}</h2>
                <Badge variant="secondary">{groups[status].length}</Badge>
              </header>
              <div className="min-h-16 space-y-2 overflow-y-auto p-2.5">
                {groups[status].map((t) => card(t))}
                {groups[status].length === 0 && <p className="px-1 py-3 text-center text-xs text-muted-foreground">{status === "in_progress" && autoOn ? `Tasks sent to ${target ?? "the agent"} show up here.` : "Drop a task here"}</p>}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 sm:px-5">
          {BOARD_STATUSES.map((status) => groups[status].length > 0 && <section key={status} aria-label={STATUS_LABEL[status]} className="space-y-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{STATUS_LABEL[status]} · {groups[status].length}</h2>
            {groups[status].map((t) => card(t, true))}
          </section>)}
        </div>
      )}
      {hiddenCount > 0 && <p className="shrink-0 px-5 pb-2 text-xs text-muted-foreground">{hiddenCount} cancelled {hiddenCount === 1 ? "task is" : "tasks are"} hidden.</p>}
      <TaskSheet task={open} onClose={() => setOpenId(null)} data={data} projectLabel={projectLabel} />
    </div>
  );
}
