import { Button } from "@/components/ui/button";
import { useMemo, useState } from "react";
import { IconMessages, IconRestore, IconSearch, IconX } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { cn } from "cn";
import { useRuntime } from "@/lib/runtime/store";
import type { RuntimeProject, SessionSummary } from "@/lib/runtime/types";
import { ProviderIcon, isLive } from "../provider";
import { STATE_DOT } from "../session-terminal";
import { PanelEmpty, RowSkeletons } from "./panel-states";

function relativeTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  return days < 30 ? `${Math.floor(days)}d` : `${Math.floor(days / 30)}mo`;
}

/** When the conversation was last active: closed ones by the time they went to sleep, live ones by start. */
function activityTime(session: SessionSummary): number {
  const iso = isLive(session.state) ? session.startedAt ?? session.createdAt : session.endedAt ?? session.startedAt ?? session.createdAt;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Date.parse(session.createdAt) || 0;
}

type Bucket = "Today" | "Yesterday" | "Last 7 days" | "Older";
const BUCKETS: Bucket[] = ["Today", "Yesterday", "Last 7 days", "Older"];

function bucketOf(ms: number): Bucket {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ms >= startOfToday.getTime()) return "Today";
  if (ms >= startOfToday.getTime() - day) return "Yesterday";
  if (ms >= startOfToday.getTime() - 7 * day) return "Last 7 days";
  return "Older";
}

interface Group { key: string; label: string; items: SessionSummary[]; closed: boolean }

function Row({ session, project, showWorkspace, active, open, closed, onActivate }: {
  session: SessionSummary;
  project?: RuntimeProject;
  showWorkspace: boolean;
  active: boolean;
  open: boolean;
  closed: boolean;
  onActivate: () => void;
}) {
  const workspace = project?.workspaces.find((item) => item.id === session.worktreeId || item.cwd === session.cwd);
  const where = showWorkspace ? session.branch ?? workspace?.branch ?? workspace?.name ?? null : null;
  const time = relativeTime(activityTime(session));
  const verb = open ? "Open" : isLive(session.state) ? "Open" : session.state === "sleeping" ? "Restore" : "Open";
  return (
    <li>
      <button
        type="button"
        title={`${session.title} · ${session.state}`}
        aria-label={`${verb} conversation ${session.title}`}
        aria-current={active ? "true" : undefined}
        onClick={onActivate}
        className={cn(
          "group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors motion-reduce:transition-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          active && "bg-accent text-accent-foreground hover:bg-accent",
          closed && !active && "text-muted-foreground hover:text-foreground",
        )}
      >
        <ProviderIcon provider={session.provider} className={cn("size-3.5", closed && "opacity-60")} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", !closed && "font-medium")}>{session.title}</span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <span aria-label={session.state} title={session.state} className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[session.state])} />
            {where && <span className="min-w-0 truncate">{where}</span>}
            {where && time && <span aria-hidden>·</span>}
            {time && <span className="shrink-0 tabular-nums">{time}</span>}
          </span>
        </span>
        <span aria-hidden className="hidden shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground group-hover:inline-flex group-focus-visible:inline-flex">
          {verb === "Restore" && <IconRestore className="size-3" />}{verb}
        </span>
      </button>
    </li>
  );
}

/** Every agent conversation of the active project (all workspaces): open tabs, running in the background, and closed ones to restore. */
export default function ConversationsTab({ projectId, project }: { projectId: string | null; project?: RuntimeProject }) {
  const { sessions, agentTabIds, focusOnCanvas, selectedId, loaded } = useRuntime();
  const [query, setQuery] = useState("");
  const multipleWorkspaces = (project?.workspaces.length ?? 0) > 1;

  const { all, groups } = useMemo(() => {
    const all = sessions.filter((session) => session.provider !== "shell" && (session.projectId ?? null) === projectId);
    const needle = query.trim().toLowerCase();
    const matching = (needle ? all.filter((session) => session.title.toLowerCase().includes(needle) || (session.branch ?? "").toLowerCase().includes(needle)) : all)
      .sort((a, b) => activityTime(b) - activityTime(a));
    const opened = new Set(agentTabIds);
    const groups: Group[] = [];
    const push = (key: string, label: string, items: SessionSummary[], closed: boolean) => { if (items.length) groups.push({ key, label, items, closed }); };
    push("open", "Open", matching.filter((session) => opened.has(session.id)), false);
    push("recent", "Recent", matching.filter((session) => !opened.has(session.id) && isLive(session.state)), false);
    const closed = matching.filter((session) => !opened.has(session.id) && !isLive(session.state));
    for (const bucket of BUCKETS) push(`closed-${bucket}`, `Closed · ${bucket}`, closed.filter((session) => bucketOf(activityTime(session)) === bucket), true);
    return { all, groups };
  }, [sessions, agentTabIds, projectId, query]);

  const opened = new Set(agentTabIds);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 bg-background/20 px-3 py-2.5">
        <div className="flex items-center justify-between px-1 text-xs">
          <span className="font-medium">Conversations</span>
          <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">{all.length}</span>
        </div>
        <div className="relative">
          <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} className="h-7 pr-6 pl-7 text-xs" />
          {query && <Button variant="ghost" size="icon-xs" type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute inset-y-0 right-1.5 my-auto size-5 text-muted-foreground"><IconX className="size-3" /></Button>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!loaded ? <RowSkeletons count={6} rowClass="h-9" />
          : groups.length === 0 ? (
            <PanelEmpty
              icon={<IconMessages />}
              title={query ? "No conversations match" : "No conversations yet"}
              hint={query ? "Try a different search." : "Closed conversations of this project show up here so you can restore them."}
            />
          ) : groups.map((group) => (
            <section key={group.key} aria-label={group.label} className="mb-1">
              <h3 className="sticky top-0 z-[1] flex items-center justify-between bg-background/85 px-2 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur-sm">
                {group.label}
                <span className="tabular-nums normal-case">{group.items.length}</span>
              </h3>
              <ul aria-label={group.label} className="flex flex-col gap-px">
                {group.items.map((session) => (
                  <Row
                    key={session.id}
                    session={session}
                    project={project}
                    showWorkspace={multipleWorkspaces}
                    active={session.id === selectedId}
                    open={opened.has(session.id)}
                    closed={group.closed}
                    onActivate={() => focusOnCanvas(session)}
                  />
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}
