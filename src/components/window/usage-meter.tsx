import { useEffect, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "cn";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useProvidersUsage } from "@/hooks/use-providers-usage";
import { useRuntime } from "@/lib/runtime/store";
import type { UsageProviderId, ProviderUsage, ProvidersUsage, UsageWindow } from "@/lib/runtime/types";

const NAME: Record<UsageProviderId, string> = { claude: "Claude", codex: "Codex" };

/** neutral < 70%, amber 70-90%, red >= 90%. */
function tone(percent: number) {
    if (percent >= 90) return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
    if (percent >= 70) return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
    return { bar: "bg-foreground/50", text: "" };
}

/** The window that will block you first: highest used %, ties go to the one resetting soonest. */
export function mostConstraining(windows: UsageWindow[]): UsageWindow | null {
    // Extra usage (overage credits) is a spend cap, not a plan window: it never drives the footer percent.
    windows = windows.filter((w) => w.id !== "extra_usage");
    const time = (w: UsageWindow) => (w.resetsAt ? new Date(w.resetsAt).getTime() : Infinity);
    return windows.reduce<UsageWindow | null>((top, w) => {
        if (!top || w.usedPercent > top.usedPercent) return w;
        return w.usedPercent === top.usedPercent && time(w) < time(top) ? w : top;
    }, null);
}

/** Tiny tag for the footer: "5h" for session windows, "w" (or "w·opus") for weekly ones. */
function windowTag(w: UsageWindow): string {
    if (w.id === "extra_usage") return "extra";
    const hours = /(\d+)h/.exec(w.label);
    if (/weekly/i.test(w.label) || /seven_day|secondary/.test(w.id)) {
        const model = /weekly\s*\S\s*(\w+)/i.exec(w.label)?.[1] ?? /seven_day_(\w+)/.exec(w.id)?.[1];
        return model ? "w·" + model.toLowerCase() : "w";
    }
    return hours ? hours[1] + "h" : w.label;
}

/** Compact duration for the footer: "45m", "1h 20m", "3d". */
function compact(iso: string | null): string | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return null;
    if (ms <= 0) return "now";
    const minutes = Math.round(ms / 60_000);
    const days = Math.floor(minutes / 1440);
    if (days > 0) return days + "d";
    const hours = Math.floor(minutes / 60);
    return hours > 0 ? hours + "h " + (minutes % 60) + "m" : minutes + "m";
}

/** "2h 10m", or "3d 4h" for longer spans. */
function remaining(iso: string | null): string | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return null;
    if (ms <= 0) return "now";
    const minutes = Math.round(ms / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function resetText(window: UsageWindow): string | null {
    const left = remaining(window.resetsAt);
    if (!left || !window.resetsAt) return null;
    const at = new Date(window.resetsAt);
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const longSpan = at.getTime() - Date.now() > 86_400_000;
    const when = longSpan ? `${at.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
    return `Resets in ${left} (${when})`;
}

function tooltip(id: UsageProviderId, window: UsageWindow): string {
    const left = remaining(window.resetsAt);
    return `${NAME[id]} · ${window.label} ${Math.round(window.usedPercent)}%${left ? ` · resets in ${left}` : ""}`;
}

function BrandIcon({ id, size = 12 }: { id: UsageProviderId; size?: number }) {
    return id === "claude" ? <IconBrandClaude size={size} className="shrink-0" /> : <IconBrandCodex size={size} className="shrink-0" />;
}

function WindowRow({ window }: { window: UsageWindow }) {
    const percent = Math.max(0, Math.min(100, window.usedPercent));
    const { bar, text } = tone(percent);
    const reset = resetText(window);
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{window.label}</span>
                <span className={cn("text-[11px] text-muted-foreground tabular-nums", text)}>{Math.round(percent)}% used</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${percent}%` }} />
            </div>
            {window.detail && <p className="text-[10px] text-muted-foreground tabular-nums">{window.detail}</p>}
            {reset && <p className="text-[10px] text-muted-foreground tabular-nums">{reset}</p>}
        </div>
    );
}

function UsagePopoverContent({
    id,
    data,
    isRefreshing,
    refresh,
}: {
    id: UsageProviderId;
    data: ProviderUsage;
    isRefreshing: boolean;
    refresh: () => Promise<void>;
}) {
    const [, tick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 30_000);
        return () => clearInterval(timer);
    }, []);

    return (
        <PopoverContent align="start" side="top" sideOffset={8} className="w-[300px] gap-0 overflow-hidden p-0">
            <div className="flex items-center gap-2 px-3 pt-3">
                <BrandIcon id={id} size={14} />
                <p className="text-xs font-medium">{NAME[id]}{data.accountLabel ? ` · ${data.accountLabel}` : ""}</p>
                {data.plan && <Badge variant="secondary">{data.plan}</Badge>}
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Refresh usage"
                    className="ml-auto -mr-1 text-muted-foreground"
                    disabled={isRefreshing}
                    onClick={() => void refresh()}
                >
                    <IconRefresh size={12} className={cn(isRefreshing && "animate-spin")} />
                </Button>
            </div>
            <Separator className="mt-3" />
            <div className="flex flex-col gap-3 px-3 py-3">
                {data.windows.length > 0 ? (
                    data.windows.map((w) => <WindowRow key={w.id} window={w} />)
                ) : data.error ? (
                    <p className="text-[11px] text-muted-foreground">Usage unavailable: {data.error}</p>
                ) : (
                    <Skeleton className="h-9 w-full" />
                )}
                {data.windows.length > 0 && data.error && <p className="text-[10px] text-muted-foreground">{data.error}</p>}
            </div>
            <Separator />
            <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[10px] text-muted-foreground">
                    {data.fetchedAt ? `Updated ${formatDistanceToNowStrict(new Date(data.fetchedAt), { addSuffix: true })}` : "Not updated yet"}
                </span>
            </div>
        </PopoverContent>
    );
}

function UsageItem({
    id,
    data,
    isRefreshing,
    refresh,
}: {
    id: UsageProviderId;
    data: ProviderUsage;
    isRefreshing: boolean;
    refresh: () => Promise<void>;
}) {
    const [open, setOpen] = useState(false);
    const top = mostConstraining(data.windows);
    const percent = top ? Math.max(0, Math.min(100, top.usedPercent)) : null;
    const { bar, text } = tone(percent ?? 0);

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) void refresh();
            }}
        >
            <PopoverTrigger asChild>
                <Button variant="ghost" size="xs"
                    type="button"
                    title={top ? tooltip(id, top) : data.error ? `${NAME[id]} usage unavailable: ${data.error}` : NAME[id] + " usage"}
                    aria-label={`Show ${NAME[id]} usage details`}
                    className={cn("gap-1.5 px-2 text-[11px] leading-none text-muted-foreground tabular-nums", open && "bg-muted text-foreground")}
                >
                    <BrandIcon id={id} />
                    <span className="h-1 w-10 shrink-0 self-center overflow-hidden rounded-full bg-foreground/10">
                        <span className={cn("block h-full rounded-full transition-all", bar)} style={{ width: `${percent ?? 0}%` }} />
                    </span>
                    <span className={cn("leading-none", text)}>{percent === null ? "—" : `${Math.round(percent)}%`}</span>
                    {!top && data.error && <span className="leading-none text-muted-foreground/80">unavailable</span>}
                    {top && (
                        <span className="leading-none text-muted-foreground/80">
                            {windowTag(top)}
                            {compact(top.resetsAt) ? " · " + compact(top.resetsAt) : ""}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>
            <UsagePopoverContent id={id} data={data} isRefreshing={isRefreshing} refresh={refresh} />
        </Popover>
    );
}

/** Footer items: one per connected provider. Hidden when signed out or the runtime has no usage endpoint. */
export function UsageMeters() {
    const { client } = useRuntime();
    const { usage, unsupported, isRefreshing, refresh } = useProvidersUsage();
    if (!client || unsupported || !usage) return null;
    return <UsageMetersView usage={usage} isRefreshing={isRefreshing} refresh={refresh} />;
}

export function UsageMetersView({ usage, isRefreshing, refresh }: { usage: ProvidersUsage; isRefreshing: boolean; refresh: () => Promise<void> }) {

    const stamps = (["claude", "codex"] as const)
        .map((id) => usage[id]?.fetchedAt)
        .filter((v): v is string => Boolean(v))
        .map((v) => new Date(v).getTime());
    const updated = stamps.length > 0 ? formatDistanceToNowStrict(new Date(Math.max(...stamps)), { addSuffix: true }) : null;

    return (
        <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs"
                type="button"
                title={"Refresh usage" + (updated ? " · updated " + updated : "")}
                aria-label="Refresh usage"
                disabled={isRefreshing}
                onClick={() => void refresh()}
                className="-ml-2 px-2 text-muted-foreground"
            >
                <IconRefresh size={12} stroke={1.5} className={cn(isRefreshing && "animate-spin")} />
            </Button>
            {(["claude", "codex"] as const).map((id) => {
                const data = usage[id];
                return data?.connected ? (
                    <UsageItem key={id} id={id} data={data} isRefreshing={isRefreshing} refresh={refresh} />
                ) : null;
            })}
        </div>
    );
}
