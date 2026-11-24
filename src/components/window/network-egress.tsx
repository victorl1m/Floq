// Footer "Network" item, egress part: the live "using your connection" indicator and the popover section with the details and the
// kill switch (docs/design/browser-user-egress.md §3.3). The relay itself is driven by BrowserEgressRelay; this only reads, stops and restarts it.
import { useEffect, useState } from "react";
import { IconPlugConnectedX, IconWorldUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { errorMessage } from "@/lib/runtime/store";
import type { RuntimeClient } from "@/lib/runtime/client";
import { describeEgress, egressSupported, formatBytes, refreshEgressStatus, startUsingMyConnection, stopUsingMyConnection, topDestinations, useBrowserEgress, type EgressStatus } from "@/lib/browser-egress";

const POLL_MS = 3_000;

/** What the footer trigger shows about egress: null when this computer is not relaying. */
export function useEgressIndicator(): { tone: "green" | "amber"; streams: number; label: string } | null {
    const { here, status } = useBrowserEgress();
    if (!egressSupported() || !here || !status || status.state === "off") return null;
    if (status.state === "up") return { tone: "green", streams: status.streams, label: status.streams > 0 ? "Using your connection" : "Your connection, idle" };
    return { tone: "amber", streams: 0, label: status.state === "standby" ? "Other computer" : status.state === "connecting" ? "Connecting" : "Connection paused" };
}

export function EgressDot({ tone, pulse }: { tone: "green" | "amber"; pulse?: boolean }) {
    return <span aria-hidden="true" data-testid="egress-dot" className={cn("size-1.5 shrink-0 rounded-full", tone === "green" ? "bg-emerald-500" : "bg-amber-500", pulse && "animate-pulse motion-reduce:animate-none")} />;
}

function since(ms: number, now: number): string {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return "under a minute";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-3 text-xs">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-right font-medium tabular-nums">{children}</dd>
        </div>
    );
}

function Details({ status, upSince }: { status: EgressStatus; upSince: number | null }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
    const hosts = topDestinations(status.recent);
    return (
        <>
            <dl className="flex flex-col gap-1" data-testid="network-egress-details">
                <Row label="Used by">Agent browser (all your projects)</Row>
                {status.machine && <Row label="Through">{status.machine}</Row>}
                <Row label="Active connections">{status.streams}</Row>
                <Row label="Traffic">{formatBytes(status.bytesPerMin)}/min</Row>
                {typeof status.rttMs === "number" && <Row label="Latency to server">{Math.round(status.rttMs)} ms</Row>}
                <Row label="Used today">{formatBytes(status.usedToday)} of {formatBytes(status.dailyCap)}</Row>
                {upSince !== null && (
                    <Row label="Since">
                        <time dateTime={new Date(upSince).toISOString()} title={new Date(upSince).toLocaleString()}>
                            {new Date(upSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ({since(upSince, now)})
                        </time>
                    </Row>
                )}
            </dl>
            {hosts.length > 0 && (
                <div className="flex flex-col gap-0.5" role="group" aria-label="Recent destinations">
                    <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Recent destinations</p>
                    <ul data-testid="network-egress-hosts" className="flex flex-col">
                        {hosts.map((h) => (
                            <li key={h.host} className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-xs hover:bg-muted/50">
                                <span className="min-w-0 flex-1 truncate" title={h.host}>{h.host}</span>
                                {h.denied > 0 && <span className="text-[10px] text-amber-700 dark:text-amber-300">{h.denied} blocked</span>}
                                <span className="text-muted-foreground tabular-nums">{h.count}×</span>
                                <span className="w-14 text-right text-muted-foreground tabular-nums">{formatBytes(h.bytes)}</span>
                            </li>
                        ))}
                    </ul>
                    <p className="px-1.5 text-[10px] text-muted-foreground">This list stays on this computer.</p>
                </div>
            )}
        </>
    );
}

/** Popover section: is the agent browser using this computer's connection, the numbers, and stop / use it again. */
export function EgressSection({ client, open }: { client: RuntimeClient | null; open: boolean }) {
    const supported = egressSupported();
    const { here, status, upSince } = useBrowserEgress();
    const [busy, setBusy] = useState(false);
    // Fresh numbers and the recent list while the popover is open (egress://status events carry no list).
    useEffect(() => {
        if (!supported || !open) return;
        void refreshEgressStatus();
        const t = setInterval(() => { if (document.visibilityState !== "hidden") void refreshEgressStatus(); }, POLL_MS);
        return () => clearInterval(t);
    }, [supported, open]);

    if (!supported) {
        return (
            <section aria-label="Your connection" data-testid="network-egress" className="flex flex-col gap-2">
                <div className="space-y-0.5">
                    <p className="text-xs font-medium">Your connection</p>
                    <p className="text-[10px] text-muted-foreground">The agent browser goes out through Floq's server. Routing it through your own connection needs the desktop app.</p>
                </div>
                <Separator />
            </section>
        );
    }
    const on = here && !!status && status.state !== "off";
    const up = status?.state === "up";
    const run = (fn: () => Promise<void>, ok: string, fail: string) => {
        if (!client || busy) return;
        setBusy(true);
        void fn().then(() => { toast.success(ok); }, (error) => { toast.error(fail, { description: errorMessage(error) }); }).finally(() => setBusy(false));
    };
    return (
        <section aria-label="Your connection" data-testid="network-egress" className="flex flex-col gap-2">
            <div className="space-y-0.5">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                    {on && <EgressDot tone={up ? "green" : "amber"} pulse={up && (status?.streams ?? 0) > 0} />}
                    Your connection
                </p>
                <p data-testid="network-egress-state" className="text-[10px] text-muted-foreground">
                    {on ? describeEgress(status) : "Not used: the agent browser goes out through Floq's server."}
                </p>
            </div>
            {on && up && status && <Details status={status} upSince={upSince} />}
            {on ? (
                <Button type="button" size="sm" variant="destructive" data-testid="network-egress-stop" disabled={busy || !client} className="w-full gap-1.5"
                    onClick={() => run(() => stopUsingMyConnection(client!), "Stopped using your connection", "Could not save the setting")}>
                    <IconPlugConnectedX size={14} aria-hidden="true" /> Stop using my connection
                </Button>
            ) : (
                <div className="flex flex-col gap-1.5">
                    <p className="text-[10px] text-muted-foreground">Turned on, websites see your internet connection and location instead of Floq's, while Floq is open on this computer.</p>
                    <Button type="button" size="sm" variant="outline" data-testid="network-egress-start" disabled={busy || !client} className="w-full gap-1.5"
                        onClick={() => run(() => startUsingMyConnection(client!), "The agent browser now uses your connection", "Could not use your connection")}>
                        <IconWorldUpload size={14} aria-hidden="true" /> Use my connection
                    </Button>
                </div>
            )}
            <Separator />
        </section>
    );
}
