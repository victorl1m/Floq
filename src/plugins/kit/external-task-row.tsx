import { IconExternalLink } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/open-external";
import type { ExternalTask, TaskStatusCategory } from "@/lib/runtime/types";
import { cn } from "cn";

/** Semantic status-category look: tokens only, never raw colors. */
export const STATUS_CATEGORY_LABEL: Record<TaskStatusCategory, string> = { todo: "To do", doing: "In progress", done: "Done" };
const CATEGORY_CLASS: Record<TaskStatusCategory, string> = {
  todo: "border-border bg-transparent text-muted-foreground",
  doing: "border-transparent bg-primary/15 text-primary-text",
  done: "border-transparent bg-muted text-muted-foreground line-through decoration-muted-foreground/40",
};

export function StatusCategoryBadge({ category, status }: { category: TaskStatusCategory; status: string }) {
  return <Badge variant="outline" data-category={category} title={STATUS_CATEGORY_LABEL[category]} className={cn("max-w-40 shrink-0", CATEGORY_CLASS[category])}><span className="truncate">{status || STATUS_CATEGORY_LABEL[category]}</span></Badge>;
}

/** One compact (13-14 px) external ticket row: id in the mono face, title, semantic status badge, and "Open in <source>". */
export function ExternalTaskRow({ task, sourceLabel, selected, onSelect }: { task: ExternalTask; sourceLabel: string; selected?: boolean; onSelect?: (task: ExternalTask) => void }) {
  return (
    <div data-slot="external-task-row" data-selected={selected ? "true" : undefined} className={cn("flex items-center gap-3 px-3 py-2 text-[13px] transition-colors motion-reduce:transition-none", selected ? "bg-muted/80" : "hover:bg-muted/50")}>
      <button type="button" onClick={() => onSelect?.(task)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="w-16 shrink-0 truncate font-mono text-xs text-muted-foreground" title={task.externalId}>{task.externalId}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
        {task.assignee && <span className="hidden max-w-32 shrink-0 truncate text-xs text-muted-foreground sm:inline">{task.assignee}</span>}
        <StatusCategoryBadge category={task.statusCategory} status={task.status} />
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={`Open in ${sourceLabel}`} title={`Open in ${sourceLabel}`} onClick={() => void openExternal(task.url)}><IconExternalLink /></Button>
    </div>
  );
}
