import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { IconArrowsMove, IconClockPlay, IconCornerDownLeft, IconDots, IconLayoutKanban, IconList, IconPlus, IconRobot } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import {
  BOARD_STATUSES, STATUS_LABEL, dropPosition, groupByStatus, sortTasks, taskOrigin, validateTaskTitle,
  type ProjectTask, type TaskStatus,
} from "@/lib/project-tasks";
import { cn } from "cn";
import TaskSheet from "./task-sheet";
import { DateChips, Pick, PriorityMark, StatusDot, typingTarget } from "./task-ui";
import type { ProjectTasksData } from "./use-project-tasks";

const VIEW_KEY = "floq.tasks.view.v1";
const readView = (): "board" | "list" => { try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"; } catch { return "board"; } };
type BoardStatus = (typeof BOARD_STATUSES)[number];

interface Props { data: ProjectTasksData; projectId: string | null; projectLabel: (id: string) => string; autoOn: boolean; target: string | null }

export default function TasksTab({ data, projectId, projectLabel, autoOn, target }: Props) {
  const { client, sessions, projects } = useRuntime();
  const [view, setView] = useState(readView);
  const [title, setTitle] = useState("");
  const [quickProject, setQuickProject] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ status: BoardStatus; index: number } | null>(null);
  const quickInput = useRef<HTMLInputElement>(null);
  const effectiveProject = projectId ?? (quickProject || projects[0]?.id || "");
  const groups = useMemo(() => groupByStatus(data.tasks), [data.tasks]);
  const open = data.tasks.find((t) => t.id === openId) ?? null;
  const agentOf = (id: string | null) => (id ? sessions.find((s) => s.id === id) : undefined);
  const hiddenCount = data.tasks.filter((t) => t.status === "cancelled").length;
  const visibleCount = data.tasks.length - hiddenCount;

  // N: new task (focus the quick add).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "n" || e.key === "N") && !e.shiftKey && !typingTarget(e)) { e.preventDefault(); quickInput.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    setAdding(true);
    try {
      const task = await client.createProjectTask(effectiveProject, { title: title.trim() });
      data.setTasks((list) => [...list, task]);
      setTitle("");
    } catch (e2) { setTitleError(errorMessage(e2)); }
    finally { setAdding(false); }
  };

  /** Index among the column's other cards where the pointer would drop. */
  const indexAt = (event: DragEvent, status: BoardStatus) => {
    const cards = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-task-id]")).filter((el) => el.dataset.taskId !== dragId);
    const i = cards.findIndex((el) => { const r = el.getBoundingClientRect(); return event.clientY < r.top + r.height / 2; });
    return i === -1 ? groups[status].filter((t) => t.id !== dragId).length : i;
  };
  const onDragOver = (event: DragEvent, status: BoardStatus) => {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const index = indexAt(event, status);
    setDrop((d) => (d?.status === status && d.index === index ? d : { status, index }));
  };
  const onDrop = (event: DragEvent, status: BoardStatus) => {
    event.preventDefault();
    const task = data.tasks.find((t) => t.id === dragId);
    const index = indexAt(event, status);
    setDragId(null); setDrop(null);
    if (task) move(task, status, index);
  };
  const endDrag = () => { setDragId(null); setDrop(null); };

  const moveMenu = (task: ProjectTask, className?: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" className={cn("relative z-10 shrink-0 text-muted-foreground", className)} aria-label={`Move “${task.title}”`}><IconDots /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"><IconArrowsMove className="size-3.5" />Move to</DropdownMenuLabel>
        {BOARD_STATUSES.filter((s) => s !== task.status).map((s) => <DropdownMenuItem key={s} onSelect={() => move(task, s)}><StatusDot status={s} />{STATUS_LABEL[s]}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const originMark = (task: ProjectTask) => {
    const origin = taskOrigin(task.createdBy);
    if (origin.kind === "agent") return <span title="Created by an agent" className="text-muted-foreground"><IconRobot aria-label="Created by an agent" className="size-3.5" /></span>;
    if (origin.kind === "automation") return <span title="Created by an automation" className="text-muted-foreground"><IconClockPlay aria-label="Created by an automation" className="size-3.5" /></span>;
    return null;
  };

  const assigneeMark = (task: ProjectTask) => {
    const a = agentOf(task.assigneeSessionId);
    if (!task.assigneeSessionId) return null;
    return a
      ? <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`Assigned to ${a.title}`}><AgentAvatar session={a} size={18} /><span className="max-w-28 truncate">{a.title}</span></span>
      : <span className="text-xs text-muted-foreground">Agent removed</span>;
  };

  const card = (task: ProjectTask) => {
    const done = task.status === "done";
    return (
      <div key={task.id} role="listitem" data-task-id={task.id} data-dragging={dragId === task.id || undefined} draggable
        onDragStart={(e) => { setDragId(task.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", task.id); }} onDragEnd={endDrag}
        className="tasks-card group relative flex flex-col gap-2 rounded-xl p-3">
        <div className="flex items-start gap-2">
          <button type="button" onClick={() => setOpenId(task.id)} aria-description="Press Enter to open. Drag, or use the menu, to move it."
            className={cn("tasks-card-open min-w-0 flex-1 text-left text-sm leading-snug font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']", done && "text-muted-foreground line-through decoration-muted-foreground/50")}>
            <span className="line-clamp-3">{task.title}</span>
          </button>
          {moveMenu(task, "-mt-0.5 -mr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100")}
        </div>
        {task.description && <p className="pointer-events-none line-clamp-2 text-xs leading-relaxed text-muted-foreground">{task.description.replace(/[#*`>_]/g, "").replace(/^\s*-\s+/gm, "")}</p>}
        <DateChips task={task} className="pointer-events-none" />
        {(!projectId || task.priority !== "normal" || task.assigneeSessionId || task.createdBy !== "user") && (
          <div className="pointer-events-none flex min-h-5 items-center gap-2">
            <PriorityMark priority={task.priority} />
            {!projectId && <span className="max-w-28 truncate text-xs text-muted-foreground">{projectLabel(task.projectId)}</span>}
            <span className="ml-auto flex min-w-0 items-center gap-2">{originMark(task)}{assigneeMark(task)}</span>
          </div>
        )}
      </div>
    );
  };

  const row = (task: ProjectTask) => (
    <div key={task.id} role="listitem" className="tasks-row group relative flex min-h-12 items-center gap-3 px-4 py-2.5">
      <StatusDot status={task.status} />
      <button type="button" onClick={() => setOpenId(task.id)} className={cn("tasks-card-open min-w-0 flex-1 truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:content-['']", task.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/50")}>{task.title}</button>
      <span className="pointer-events-none hidden items-center gap-3 md:flex">
        {!projectId && <span className="max-w-32 truncate text-xs text-muted-foreground">{projectLabel(task.projectId)}</span>}
        <DateChips task={task} />
        {originMark(task)}
      </span>
      <PriorityMark priority={task.priority} className="pointer-events-none" />
      <span className="pointer-events-none hidden sm:inline-flex">{assigneeMark(task)}</span>
      {moveMenu(task)}
    </div>
  );

  const emptyColumn = (status: BoardStatus) =>
    status === "in_progress" && autoOn ? `Tasks sent to ${target ?? "the agent"} show up here.`
      : status === "todo" ? "Nothing waiting."
        : status === "done" ? "Finished tasks land here."
          : "Drag a task here.";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start gap-2 px-4 pb-4 sm:px-8">
        <form onSubmit={add} noValidate className="min-w-0 flex-1 basis-80">
          <div className="tasks-quickadd flex h-10 items-center gap-1 rounded-xl pr-1.5 pl-3" data-invalid={!!titleError || undefined}>
            <IconPlus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <label htmlFor="tasks-quick-add" className="sr-only">New task title</label>
            <input id="tasks-quick-add" ref={quickInput} value={title} maxLength={220} autoComplete="off"
              onChange={(e) => { setTitle(e.target.value); setTitleError(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setTitle(""); setTitleError(null); e.currentTarget.blur(); } }}
              placeholder="Add a task" aria-invalid={!!titleError} aria-describedby={titleError ? "task-title-error" : "task-quick-hint"}
              className="h-full min-w-0 flex-1 border-0 bg-transparent px-1.5 text-sm shadow-none outline-none ring-0 placeholder:text-muted-foreground/80 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none!" />
            {!projectId && projects.length > 1 && (
              <Pick label="Project for the new task" value={effectiveProject} onChange={setQuickProject} size="sm" className="max-w-44 border-transparent bg-transparent shadow-none dark:bg-transparent" options={projects.map((p) => ({ value: p.id, label: projectLabel(p.id) }))} />
            )}
            {title.trim()
              ? <Button type="submit" size="sm" disabled={!effectiveProject || adding} className="shrink-0"><IconCornerDownLeft />{adding ? "Adding…" : "Add"}</Button>
              : <span id="task-quick-hint" className="hidden shrink-0 items-center gap-1.5 pr-1.5 text-xs text-muted-foreground sm:flex">Press <Kbd>N</Kbd> anywhere</span>}
          </div>
          {titleError && <p id="task-title-error" role="alert" className="mt-1.5 px-1 text-xs text-destructive">{titleError}</p>}
        </form>
        <ToggleGroup type="single" value={view} onValueChange={changeView} variant="outline" size="sm" spacing={0} aria-label="Task layout" className="h-10 shrink-0">
          <ToggleGroupItem value="board" aria-label="Board" className="h-10 px-3"><IconLayoutKanban /><span className="hidden lg:inline">Board</span></ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List" className="h-10 px-3"><IconList /><span className="hidden lg:inline">List</span></ToggleGroupItem>
        </ToggleGroup>
      </div>

      {data.error && <div className="px-4 pb-3 sm:px-8"><ErrorBanner>{data.error}<Button className="ml-3 h-7" size="sm" variant="outline" onClick={() => void data.reload()}>Retry</Button></ErrorBanner></div>}

      {data.loading ? (
        <div role="status" aria-busy="true" aria-label="Loading tasks" className="flex min-h-0 flex-1 gap-3 overflow-hidden px-4 sm:px-8">
          {[3, 2, 1, 1].map((n, i) => (
            <div key={i} className="tasks-column w-[min(19rem,84vw)] shrink-0 self-start rounded-2xl">
              <div className="tasks-column-head flex h-11 items-center gap-2 px-3.5"><Skeleton rows={1} className="h-3 w-20" /></div>
              <div className="space-y-2 p-2">{Array.from({ length: n }, (_, j) => <Skeleton key={j} rows={1} className="h-[72px] w-full rounded-xl" />)}</div>
            </div>
          ))}
        </div>
      ) : visibleCount === 0 && !data.error ? (
        <Empty className="mx-auto mt-[6vh] mb-auto max-w-md border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><IconRobot /></EmptyMedia>
            <EmptyTitle>No tasks yet</EmptyTitle>
            <EmptyDescription>
              Write down what needs doing. With “Agents work on tasks” on, the project’s agent picks each task up and reports back here.
              Set a Run on date to start one later.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button size="sm" onClick={() => quickInput.current?.focus()} disabled={projects.length === 0}><IconPlus />Add the first task</Button></EmptyContent>
        </Empty>
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pb-5 sm:px-8" role="group" aria-label="Task board">
          {BOARD_STATUSES.map((status) => {
            const column = groups[status];
            const others = column.filter((t) => t.id !== dragId);
            const target = drop?.status === status ? drop.index : -1;
            return (
              <section key={status} aria-labelledby={`tasks-col-${status}`}
                data-drop={drop?.status === status || undefined}
                onDragOver={(e) => onDragOver(e, status)}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop((d) => (d?.status === status ? null : d)); }}
                onDrop={(e) => onDrop(e, status)}
                className="tasks-column flex max-h-full w-[min(19rem,84vw)] shrink-0 flex-col rounded-2xl">
                <header className="tasks-column-head flex h-11 shrink-0 items-center gap-2 px-3.5">
                  <StatusDot status={status} />
                  <h2 id={`tasks-col-${status}`} className="text-sm font-medium">{STATUS_LABEL[status]}</h2>
                  <span className="text-xs text-muted-foreground tabular-nums" aria-label={`${column.length} tasks`}>{column.length}</span>
                </header>
                <div role="list" aria-labelledby={`tasks-col-${status}`} className="flex min-h-20 flex-col gap-2 overflow-y-auto p-2">
                  {(() => {
                    // The dragged card stays where it is (dimmed); the line marks the slot among the other cards.
                    let n = 0;
                    return column.map((t) => {
                      if (t.id === dragId) return card(t);
                      const line = n++ === target ? <div key={`drop-${t.id}`} aria-hidden className="tasks-drop-line" /> : null;
                      return [line, card(t)];
                    });
                  })()}
                  {target === others.length && <div aria-hidden className="tasks-drop-line" />}
                  {column.length === 0 && !drop && <p className="px-2 py-5 text-center text-xs text-muted-foreground">{emptyColumn(status)}</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-8">
          <div className="mx-auto flex max-w-[960px] flex-col gap-6">
            {BOARD_STATUSES.map((status) => groups[status].length > 0 && (
              <section key={status} aria-labelledby={`tasks-list-${status}`} className="flex flex-col gap-2">
                <h2 id={`tasks-list-${status}`} className="flex items-center gap-2 px-1 text-sm font-medium text-muted-foreground">
                  <StatusDot status={status} />{STATUS_LABEL[status]}<span className="font-normal tabular-nums">{groups[status].length}</span>
                </h2>
                <div role="list" className="settings-group material-content divide-y divide-border rounded-2xl [&>div]:p-0!">
                  {groups[status].map(row)}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
      {hiddenCount > 0 && <p className="shrink-0 px-4 pb-3 text-xs text-muted-foreground sm:px-8">{hiddenCount} cancelled {hiddenCount === 1 ? "task is" : "tasks are"} hidden.</p>}
      <TaskSheet task={open} onClose={() => setOpenId(null)} data={data} projectLabel={projectLabel} />
    </div>
  );
}
