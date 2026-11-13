// Settings > Browser: route the agent browser's traffic through this computer (docs/design/browser-user-egress.md §4.1, §6).
// Presentational: the parent owns the runtime setting (`mode`) and saves it; this owns the per-machine choice and policy.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeEgress, egressSupported, formatBytes, GIB, refreshEgressStatus, setEgressHere, setEgressPolicy, stopEgress, useBrowserEgress } from "@/lib/browser-egress";
import type { BrowserEgressMode } from "@/lib/runtime/browser-types";
import { SettingRow } from "./ui";

const CAPS = [1, 5, 10, 50, 200];

export function BrowserEgressSettings({ mode, onMode }: { mode: BrowserEgressMode; onMode: (mode: BrowserEgressMode) => Promise<void> }) {
    const supported = egressSupported();
    const { here, policy, status } = useBrowserEgress();
    const [busy, setBusy] = useState(false);
    const on = here && mode !== "server";
    const [recentOpen, setRecentOpen] = useState(false);

    // Live numbers and the recent list come from the Rust side; poll only while it is visible and on.
    useEffect(() => {
        if (!supported || !on) return;
        void refreshEgressStatus();
        const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refreshEgressStatus(); }, 3_000);
        return () => clearInterval(timer);
    }, [supported, on]);

    async function toggle(next: boolean) {
        setBusy(true);
        try {
            if (next) { setEgressHere(true); await onMode(mode === "desktop-fallback" ? "desktop-fallback" : "desktop"); }
            else { setEgressHere(false); await stopEgress(); await onMode("server"); }
        } catch (error) {
            setEgressHere(!next);
            toast.error("Could not change the browser connection", { description: error instanceof Error ? error.message : String(error) });
        } finally { setBusy(false); }
    }

    if (!supported) {
        return (
            <SettingRow settingId="browser-egress" label="Route browser traffic through this computer" description="Websites would see your own internet connection instead of Floq's server.">
                <span data-testid="egress-web-note" className="text-xs text-muted-foreground">Available in the desktop app</span>
            </SettingRow>
        );
    }
    return (
        <>
            <SettingRow settingId="browser-egress"
                label="Route browser traffic through this computer"
                htmlFor="browser-egress"
                description={<>
                    Websites will see your internet connection and location instead of Floq&apos;s server. Your computer must be on with Floq open. Agents can then browse as you, from your IP.
                    <span className="mt-1 block">Switching restarts the browser; you may need to log in again on some sites.</span>
                </>}
            >
                <Switch id="browser-egress" checked={on} disabled={busy} onCheckedChange={(v) => void toggle(v)} />
            </SettingRow>
            <EgressHelp />
            {on && (
                <>
                    <SettingRow label="Connection" description={status?.machine ? `This computer: ${status.machine}` : undefined}>
                        <span role="status" data-testid="egress-status" className="text-xs text-muted-foreground">{describeEgress(status)}</span>
                        <Button type="button" variant="outline" size="sm" data-testid="egress-stop" disabled={busy} onClick={() => void toggle(false)}>Stop using my connection</Button>
                    </SettingRow>
                    <SettingRow label="If this computer is offline" description="Pausing keeps your IP private: nothing reaches the internet from the server while Floq is closed on your computer.">
                        <RadioGroup aria-label="If this computer is offline" value={mode === "desktop-fallback" ? "desktop-fallback" : "desktop"} disabled={busy} className="gap-2"
                            onValueChange={(value) => { setBusy(true); void onMode(value as BrowserEgressMode).catch((error) => toast.error("Could not save", { description: String(error) })).finally(() => setBusy(false)); }}>
                            {([["desktop", "Pause the browser"], ["desktop-fallback", "Use the server's connection"]] as const).map(([value, label]) => (
                                <div key={value} className="flex items-center gap-2">
                                    <RadioGroupItem id={`egress-offline-${value}`} value={value} />
                                    <Label htmlFor={`egress-offline-${value}`} className="cursor-pointer text-sm font-normal">
                                        {label}{value === "desktop" && <span className="text-xs text-muted-foreground">(default)</span>}
                                    </Label>
                                </div>
                            ))}
                        </RadioGroup>
                    </SettingRow>
                    <details className="group p-4" data-testid="egress-advanced">
                        <summary className="cursor-pointer select-none text-sm font-medium">Advanced</summary>
                        <div className="mt-3 flex flex-col gap-4 text-sm">
                            <label className="flex items-center justify-between gap-4">
                                <span>Daily data cap <span className="block text-xs text-muted-foreground">Used today: {formatBytes(status?.usedToday ?? 0)}. Resets at local midnight.</span></span>
                                <Select value={String(CAPS.includes(Math.round(policy.dailyCapBytes / GIB)) ? Math.round(policy.dailyCapBytes / GIB) : 10)}
                                    onValueChange={(v) => setEgressPolicy({ ...policy, dailyCapBytes: Number(v) * GIB })}>
                                    <SelectTrigger size="sm" aria-label="Daily data cap" data-testid="egress-cap" className="w-24"><SelectValue /></SelectTrigger>
                                    <SelectContent>{CAPS.map((gib) => <SelectItem key={gib} value={String(gib)}>{gib} GB</SelectItem>)}</SelectContent>
                                </Select>
                            </label>
                            <label className="flex items-start justify-between gap-4">
                                <span>Allow other ports <span className="block max-w-prose text-xs text-muted-foreground">Only web ports (80, 443, 8080, 8443) are allowed by default. Other ports can reach mail, SSH and database servers from your IP. Your local network stays blocked either way.</span></span>
                                <Switch aria-label="Allow other ports" data-testid="egress-ports" checked={policy.allowOtherPorts} onCheckedChange={(v) => setEgressPolicy({ ...policy, allowOtherPorts: v })} />
                            </label>
                            <div>
                                <button type="button" className="text-sm font-medium underline-offset-2 hover:underline" data-testid="egress-recent-toggle" aria-expanded={recentOpen} onClick={() => setRecentOpen((v) => !v)}>Recent connections</button>
                                <p className="text-xs text-muted-foreground">What your connection was used for. Stays on this computer and is never sent anywhere.</p>
                                {recentOpen && <RecentList recent={status?.recent ?? []} />}
                            </div>
                        </div>
                    </details>
                </>
            )}
        </>
    );
}

function RecentList({ recent }: { recent: NonNullable<ReturnType<typeof useBrowserEgress>["status"]>["recent"] }) {
    const list = recent ?? [];
    if (list.length === 0) return <p data-testid="egress-recent-empty" className="mt-2 text-xs text-muted-foreground">Nothing yet.</p>;
    return (
        <ul data-testid="egress-recent" className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border text-xs">
            {list.slice(0, 100).map((entry, index) => (
                <li key={`${entry.start}-${index}`} className="flex items-center gap-2 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate font-mono">{entry.host}:{entry.port}</span>
                    <span className="text-muted-foreground">{formatBytes(entry.bytes)}</span>
                    <span className="w-24 truncate text-right text-muted-foreground">{entry.result}</span>
                    <time className="text-muted-foreground" dateTime={new Date(entry.start).toISOString()}>{new Date(entry.start).toLocaleTimeString()}</time>
                </li>
            ))}
        </ul>
    );
}

/** The honest limits (design §6): shown in Settings so nobody expects this to defeat bot checks. */
function EgressHelp() {
    return (
        <div data-testid="egress-help" className="space-y-1.5 px-4 pb-4 text-xs leading-relaxed text-muted-foreground">
            <p><span className="font-medium text-foreground">What it does.</span> Sites see your IP, your internet provider and your approximate location. Blocks aimed at server IP ranges, &quot;unusual traffic&quot; warnings, region-locked content and &quot;new location&quot; login checks caused by Floq&apos;s server should go away or calm down.</p>
            <p><span className="font-medium text-foreground">What it does not do.</span> It does not make the browser look human. Bot checks such as Cloudflare or DataDome also look at the browser itself, so challenges may still appear; you can solve them in the Browser node. Floq changes nothing about the browser&apos;s identity. Time zone and language stay the server&apos;s, so a site may notice they differ from your location.</p>
            <p><span className="font-medium text-foreground">Cost and limits.</span> Every request makes an extra trip through your computer, so pages load slower, more so on a weak connection. It only works while your computer is on, online and running Floq. Browser traffic comes from your IP, so you are responsible for what agents do with it. Only websites (web ports) are reachable, never your local network.</p>
        </div>
    );
}
