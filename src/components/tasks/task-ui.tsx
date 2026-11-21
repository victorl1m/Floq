import { IconAlarm, IconCalendarEvent, IconChevronDown, IconChevronUp, IconChevronsUp } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PRIORITY_LABEL, STATUS_LABEL, formatDay, formatWhen, isOverdue, type ProjectTask, type TaskPriority, type TaskStatus } from "@/lib/project-tasks";

/** Status colour: one dot per status, the same on the board, the list and the sheet. */
export const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/45",
  in_progress: "bg-sky-500",
  blocked: "bg-amber-500",
  done: "bg-emerald-500",
  cancelled: "bg-muted-foreground/25",
};

export function StatusDot({ status, className }: { status: TaskStatus; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_DOT[status], className)} />;
}

const PRIORITY_ICON = { urgent: IconChevronsUp, high: IconChevronUp, low: IconChevronDown } as const;
const PRIORITY_TONE: Record<TaskPriority, string> = {
  urgent: "text-red-600 dark:text-red-400",
  high: "text-amber-700 dark:text-amber-400",
  normal: "text-muted-foreground",
  low: "text-muted-foreground",
};

/** Priority as an arrow and a word. Normal priority shows nothing unless `always` (the sheet). */
export function PriorityMark({ priority, always = false, className }: { priority: TaskPriority; always?: boolean; className?: string }) {
  if (priority === "normal" && !always) return null;
  const Icon = priority === "normal" ? null : PRIORITY_ICON[priority];
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", PRIORITY_TONE[priority], className)} title={`${PRIORITY_LABEL[priority]} priority`}>
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {PRIORITY_LABEL[priority]}<span className="sr-only"> priority</span>
    </span>
  );
}

/** Small chips for dates: "Runs Nov 24, 09:00" (waiting for its trigger) and "Due Nov 30" (red when overdue). */
export function DateChips({ task, className }: { task: ProjectTask; className?: string }) {
  const waiting = task.status === "todo" && !!task.runAt && Date.parse(task.runAt) > Date.now();
  const overdue = isOverdue(task);
  if (!waiting && !task.dueAt) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {waiting && (
        <span className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground" title={`Agents start this only on ${formatWhen(task.runAt!)}`}>
          <IconAlarm aria-hidden className="size-3" />Runs {formatWhen(task.runAt!)}
        </span>
      )}
      {task.dueAt && (
        <span className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium", overdue ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
          <IconCalendarEvent aria-hidden className="size-3" />{overdue ? "Overdue" : "Due"} {formatDay(task.dueAt)}
        </span>
      )}
    </span>
  );
}

export const statusLabel = (s: TaskStatus) => STATUS_LABEL[s];

/** True when a keystroke belongs to a field, a menu or a dialog rather than to the page shortcut. */
export function typingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return true;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
}

const EMPTY_VALUE = "__floq_empty__";
/** shadcn Select with a flat option list. Radix forbids "" as an item value, so "" is mapped to a sentinel and back. */
export function Pick({ id, value, onChange, options, className, size, label }: {
  id?: string; value: string; onChange: (value: string) => void; options: { value: string; label: ReactNode }[];
  className?: string; size?: "sm" | "default"; label?: string;
}) {
  const wrap = (v: string) => (v === "" ? EMPTY_VALUE : v);
  return (
    <Select value={wrap(value)} onValueChange={(v) => onChange(v === EMPTY_VALUE ? "" : v)}>
      <SelectTrigger id={id} size={size} aria-label={label} className={className}><SelectValue /></SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {options.map((o) => <SelectItem key={o.value} value={wrap(o.value)}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
