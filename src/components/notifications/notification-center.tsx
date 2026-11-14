import { useMemo, useState } from "react";
import { IconBell, IconChecks, IconTrash } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRuntime } from "@/lib/runtime/store";
import {
  applyFilters, CATEGORIES, groupByDay, LEVELS, noFilters, relativeTime,
  type AppNotification, type NotificationCategory, type NotificationFilters, type NotificationLevel,
} from "@/lib/notifications";
import { levelMeta } from "./level";
import { useNotifications } from "./notifications-provider";
import { useNotificationAction } from "./use-notification-action";

function NotificationRow({ n, projectName, onOpen }: { n: AppNotification; projectName: string | null; onOpen: (n: AppNotification) => void }) {
  const { markRead, clear } = useNotifications();
  const { Icon, tone, label } = levelMeta[n.level];
  const unread = !n.readAt;
  const from = [n.sessionName, projectName].filter(Boolean).join(" · ");
  return (
    <li data-testid="notification-row" data-level={n.level} data-unread={unread} className={cn("group relative flex gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60", unread && "bg-muted/35")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-label={label} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className={cn("min-w-0 flex-1 text-sm leading-snug break-words", unread ? "font-medium" : "text-muted-foreground")}>{n.title}</p>
          <time dateTime={n.createdAt} className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{relativeTime(n.createdAt)}</time>
        </div>
        {n.body && <p className="mt-0.5 text-xs leading-snug break-words whitespace-pre-wrap text-muted-foreground">{n.body}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="rounded-full border border-border/70 px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{n.category}</span>
          {from && <span className="min-w-0 truncate text-xs text-muted-foreground">{from}</span>}
          {n.action && (
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => onOpen(n)}>{n.action.label}</Button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
        {unread ? (
          <button type="button" aria-label="Mark as read" title="Mark as read" onClick={() => markRead([n.id])} className="grid size-4 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span data-testid="unread-dot" className="size-2 rounded-full bg-primary" />
          </button>
        ) : <span className="size-4" />}
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={() => clear([n.id])} className="grid size-4 cursor-pointer place-items-center rounded text-muted-foreground opacity-0 transition-opacity outline-none group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
          <IconTrash className="size-3" />
        </button>
      </div>
    </li>
  );
}

export function NotificationCenterPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { items, unread, markRead, markAllRead, clear } = useNotifications();
  const { projects } = useRuntime();
  const run = useNotificationAction();
  const [filters, setFilters] = useState<NotificationFilters>(noFilters);
  const projectName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? null : null);
  const projectIds = useMemo(() => [...new Set(items.map((n) => n.projectId).filter((id): id is string => !!id))], [items]);
  const visible = useMemo(() => applyFilters(items, filters), [items, filters]);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const filtered = filters.level !== "all" || filters.category !== "all" || filters.project !== "all";
  const open = (n: AppNotification) => { run(n); markRead([n.id]); onNavigate?.(); };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="notification-center">
      <div className="flex items-center gap-1 px-1">
        <h2 className="mr-auto text-sm font-medium">Notifications{unread > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{unread} unread</span>}</h2>
        <Button size="xs" variant="ghost" disabled={unread === 0} onClick={markAllRead}><IconChecks />Mark all read</Button>
        <Button size="xs" variant="ghost" disabled={items.length === 0} onClick={() => clear(filtered ? visible.map((n) => n.id) : "all")}><IconTrash />Clear</Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-1" role="group" aria-label="Filter notifications">
        <div className="flex gap-1" role="radiogroup" aria-label="Level">
          {(["all", ...LEVELS] as const).map((level) => {
            const on = filters.level === level;
            return (
              <button key={level} type="button" role="radio" aria-checked={on} onClick={() => setFilters((f) => ({ ...f, level }))}
                className={cn("cursor-pointer rounded-full border px-2 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", on ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground")}>
                {level === "all" ? "All" : levelMeta[level as NotificationLevel].label}
              </button>
            );
          })}
        </div>
        <NativeSelect size="sm" className="ml-auto" aria-label="Category" value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as NotificationCategory | "all" }))}>
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </NativeSelect>
        {projectIds.length > 0 && (
          <NativeSelect size="sm" className="max-w-36" aria-label="Project" value={filters.project} onChange={(e) => setFilters((f) => ({ ...f, project: e.target.value }))}>
              <option value="all">All projects</option>
              {projectIds.map((id) => <option key={id} value={id}>{projectName(id) ?? "Project"}</option>)}
            </NativeSelect>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {groups.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground" data-testid="notification-empty">{items.length === 0 ? "Nothing yet. Updates from your agents show up here." : "No notifications match these filters."}</p>
        ) : groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="mb-1">
            <h3 className="sticky top-0 z-10 px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur-sm">{group.label}</h3>
            <ul className="flex flex-col">
              {group.items.map((n) => <NotificationRow key={n.id} n={n} projectName={projectName(n.projectId)} onOpen={open} />)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Bell with unread badge for the window chrome; opens the Notification Center panel. */
export function NotificationBell({ className }: { className?: string }) {
  const { unread } = useNotifications();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" data-testid="notification-bell" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} title="Notifications" className={cn("relative mr-1 shrink-0 text-muted-foreground! transition-colors hover:text-foreground!", className)}>
          <IconBell />
          {unread > 0 && (
            <span data-testid="notification-badge" className="pointer-events-none absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">{unread > 99 ? "99+" : unread}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="h-[min(34rem,calc(100dvh-3.5rem))] w-[min(26rem,calc(100vw-1rem))] gap-0 p-2">
        <NotificationCenterPanel onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
