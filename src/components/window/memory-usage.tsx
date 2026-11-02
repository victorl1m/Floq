import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
    IconRefresh,
    IconServer,
    IconServerOff,
} from "@tabler/icons-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
    useMemoryDetails,
    type MemoryDetails,
    type ProcessMemory,
} from "@/hooks/use-memory-details";

export function formatMemory(bytes: number) {
    const megabytes = bytes / 1024 / 1024;

    if (megabytes < 1024) {
        return `${megabytes.toFixed(1)} MB`;
    }

    return `${(megabytes / 1024).toFixed(2)} GB`;
}

function formatShare(value: number) {
    if (value > 0 && value < 0.1) return "<0.1";
    return value.toFixed(1);
}

function processLabel(name: string) {
    const label = name.replace(/\.exe$/i, "");
    return label.length > 0 ? label : "Unknown";
}

function ProcessRow({
    process,
    maxMemory,
}: {
    process: ProcessMemory;
    maxMemory: number;
}) {
    const share = maxMemory > 0 ? (process.memory / maxMemory) * 100 : 0;

    return (
        <div className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/60">
            <div className="flex items-center gap-2">
                <span
                    className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        process.isMain
                            ? "bg-primary"
                            : "bg-muted-foreground/40",
                    )}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] leading-tight font-medium">
                            {processLabel(process.name)}
                        </span>
                        {process.isMain && (
                            <Badge
                                variant="outline"
                                className="h-4 px-1 text-[9px] font-normal text-muted-foreground"
                            >
                                main
                            </Badge>
                        )}
                    </div>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                        pid {process.pid}
                    </span>
                </div>
                <span className="text-[10px] font-medium tabular-nums">
                    {formatMemory(process.memory)}
                </span>
            </div>
            <Progress value={share} className="mt-1 h-0.5" />
        </div>
    );
}

function MemoryPopoverContent({
    details,
    isRefreshing,
    hasError,
    refresh,
}: {
    details: MemoryDetails | null;
    isRefreshing: boolean;
    hasError: boolean;
    refresh: () => Promise<void>;
}) {
    if (!details && !isTauri()) {
        return (
            <PopoverContent
                align="end"
                side="top"
                sideOffset={8}
                className="w-80 gap-0 overflow-hidden p-0"
            >
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <IconServerOff size={16} />
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-xs font-medium">Desktop only</p>
                        <p className="text-[10px] text-muted-foreground">
                            Open the desktop app to see process memory.
                        </p>
                    </div>
                </div>
            </PopoverContent>
        );
    }

    if (!details && hasError) {
        return (
            <PopoverContent
                align="end"
                side="top"
                sideOffset={8}
                className="w-80 gap-0 overflow-hidden p-0"
            >
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <IconServerOff size={16} />
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-xs font-medium">
                            Memory unavailable
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                            The last refresh failed.
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void refresh()}
                        disabled={isRefreshing}
                    >
                        <IconRefresh
                            size={12}
                            className={cn(isRefreshing && "animate-spin")}
                        />
                        Retry
                    </Button>
                </div>
            </PopoverContent>
        );
    }

    if (!details) {
        return (
            <PopoverContent
                align="end"
                side="top"
                sideOffset={8}
                className="w-80 gap-0 overflow-hidden p-0"
            >
                <div className="flex flex-col gap-3 p-3">
                    <div className="flex items-center justify-between">
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-4 w-12" />
                    </div>
                    <Skeleton className="h-7 w-32" />
                    <Skeleton className="h-1.5 w-full" />
                    <Separator />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                </div>
            </PopoverContent>
        );
    }

    const processes = details.processes;
    const maxMemory = processes[0]?.memory ?? 0;
    const share =
        details.systemTotal > 0
            ? Math.min(100, (details.total / details.systemTotal) * 100)
            : 0;

    return (
        <PopoverContent
            align="end"
            side="top"
            sideOffset={8}
            className="w-80 gap-0 overflow-hidden p-0"
        >
            <div className="flex items-center justify-between px-3 pt-3">
                <div className="space-y-0.5">
                    <p className="text-xs font-medium">Memory usage</p>
                    <p className="text-[10px] text-muted-foreground">
                        Application process tree
                    </p>
                </div>
            </div>

            <div className="space-y-2 px-3 pt-3">
                <div className="flex items-end justify-between gap-3">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums">
                        {formatMemory(details.total)}
                    </span>
                    <span className="pb-0.5 text-[10px] text-muted-foreground tabular-nums">
                        {formatShare(share)}% of{" "}
                        {formatMemory(details.systemTotal)}
                    </span>
                </div>
                <Progress value={share} className="h-1.5" />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{processes.length} processes</span>
                    <span className="tabular-nums">
                        {formatMemory(details.systemUsed)} system used
                    </span>
                </div>
            </div>

            <Separator className="my-3" />

            <div className="flex items-center justify-between px-3">
                <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    Processes
                </p>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void refresh()}
                    disabled={isRefreshing}
                    aria-label="Refresh memory usage"
                    className="-mr-1 text-muted-foreground"
                >
                    <IconRefresh
                        size={12}
                        className={cn(isRefreshing && "animate-spin")}
                    />
                </Button>
            </div>

            <ScrollArea className="mt-1 h-52">
                <div className="flex flex-col gap-0.5 px-2 pb-2">
                    {processes.map((process) => (
                        <ProcessRow
                            key={process.pid}
                            process={process}
                            maxMemory={maxMemory}
                        />
                    ))}
                </div>
            </ScrollArea>
        </PopoverContent>
    );
}

export function MemoryUsageButton() {
    const [open, setOpen] = useState(false);
    const { details, isRefreshing, hasError, refresh } = useMemoryDetails();

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    title="Memory usage"
                    aria-label="Show memory usage details"
                    className={cn(
                        "-mr-2 inline-flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[11px] text-muted-foreground tabular-nums transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                        open && "bg-muted text-foreground",
                    )}
                >
                    <IconServer size={12} stroke={1.5} />
                    <span>{details ? formatMemory(details.total) : "—"}</span>
                </button>
            </PopoverTrigger>
            <MemoryPopoverContent
                details={details}
                isRefreshing={isRefreshing}
                hasError={hasError}
                refresh={refresh}
            />
        </Popover>
    );
}
