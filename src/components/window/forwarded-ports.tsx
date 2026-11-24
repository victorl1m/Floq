import { useState } from "react";
import { IconAppWindow, IconBug, IconCopy, IconExternalLink, IconNetwork, IconX, IconChevronRight } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ManualForwardForm, useActiveForwardSession } from "@/components/window/manual-forward-form";
import { errorMessage } from "@/lib/runtime/store";
import { usePortRequests } from "@/lib/port-requests";
import { PortRequestCard } from "@/components/window/port-requests";
import { openDebugLink, portForwardingSupported, startForward, stopForward, usePortForwarding } from "@/lib/port-forwarding";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionDebugLink } from "@/lib/runtime/types";
import { EgressDot, EgressSection, useEgressIndicator } from "@/components/window/network-egress";

function copyUrl(port: number) {
    navigator.clipboard.writeText(`http://localhost:${port}`).then(
        () => toast.success("URL copied", { description: "It is on your clipboard." }),
        () => toast.error("Could not copy the URL", { description: "The browser blocked clipboard access." }),
    );
}

function openLink(client: RuntimeClient, sessionId: string, link: SessionDebugLink) {
    void openDebugLink(client, sessionId, link).catch((error) => toast.error(`Could not open ${link.label}`, { description: errorMessage(error) }));
}

function forwardLinkPorts(client: RuntimeClient, sessionId: string, link: SessionDebugLink) {
    void startForward(client, sessionId, link.port).then(
        () => toast.success(`Forwarding localhost:${link.port}`, { description: `${link.label} is reachable from this computer.` }),
        (error) => toast.error(`Could not forward port ${link.port}`, { description: errorMessage(error) }),
    );
}

/** App previews and debuggers the agent started (Flutter web, Vite/Tauri dev server, DevTools), detected by the runtime. */
function Previews({ links, client, sessionId }: { links: SessionDebugLink[]; client: RuntimeClient | null; sessionId: string | null }) {
    if (links.length === 0) return null;
    return (
        <div className="flex flex-col gap-0.5" role="group" aria-label="App previews">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Previews</p>
            {links.map((link) => {
                const Icon = link.kind === "preview" ? IconAppWindow : IconBug;
                const action = link.kind === "preview" ? "Open preview" : link.kind === "devtools" ? "Open DevTools" : "Forward";
                return (
                    <div key={link.url} className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
                        <Icon size={12} stroke={1.5} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-medium" title={link.url}>{link.label} <span className="font-normal text-muted-foreground tabular-nums">:{link.port}</span></span>
                        {portForwardingSupported && client && sessionId && (
                            <Button type="button" variant="outline" size="xs" aria-label={`${action}: ${link.label} on port ${link.port}`}
                                onClick={() => (link.kind === "vm-service" ? forwardLinkPorts(client, sessionId, link) : openLink(client, sessionId, link))}
                            >
                                {action}
                            </Button>
                        )}
                    </div>
                );
            })}
            {!portForwardingSupported && <p className="px-1.5 text-[10px] text-muted-foreground">Open previews from the Floq desktop app: it forwards the port to this computer.</p>}
            <Separator className="mt-2" />
        </div>
    );
}

/**
 * Footer "Network" item: forwarded ports count and, while the agent browser goes out through this computer, a live
 * "Using your connection" indicator. Its popover holds the egress details with the kill switch, then the ports (list, manual forward).
 */
export function NetworkStatus() {
    const [open, setOpen] = useState(false);
    const { forwarded, ports, links: allLinks } = usePortForwarding();
    const { client, sessionId } = useActiveForwardSession();
    const forwardedPorts = Object.keys(forwarded).map(Number).sort((a, b) => a - b);
    const count = forwardedPorts.length;
    const detected = (sessionId ? ports[sessionId] ?? [] : []).filter(({ port }) => !forwarded[port]);
    const links = sessionId ? allLinks[sessionId] ?? [] : [];
    const requests = usePortRequests();
    const waiting = requests.filter((item) => item.state === "pending").length;
    const egress = useEgressIndicator();
    const label = `Network: ${count} port${count === 1 ? "" : "s"} forwarded${egress ? `, ${egress.label.toLowerCase()}${egress.streams ? ` (${egress.streams} connection${egress.streams === 1 ? "" : "s"})` : ""}` : ""}${waiting ? `, ${waiting} request${waiting === 1 ? "" : "s"} waiting for your answer` : ""}`;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="xs"
                    type="button"
                    title={label}
                    aria-label={label}
                    data-testid="network-footer"
                    className={cn("-mr-2 ml-2 gap-1.5 px-2 text-[11px] tabular-nums", count === 0 && !waiting && !egress && "opacity-60", open && "bg-muted text-foreground")}
                >
                    <IconNetwork size={12} stroke={1.5} aria-hidden="true" />
                    <span>Network</span>
                    {(count > 0 || !egress) && <span>{count}</span>}
                    {egress && (
                        <span data-testid="network-egress-indicator" data-tone={egress.tone} className={cn("flex items-center gap-1 rounded-full border px-1.5 leading-4", egress.tone === "green" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-amber-500/40 text-amber-700 dark:text-amber-300")}>
                            <EgressDot tone={egress.tone} pulse={egress.streams > 0} />
                            <span>{egress.label}</span>
                            {egress.streams > 0 && <span className="text-muted-foreground">· {egress.streams}</span>}
                        </span>
                    )}
                    {waiting > 0 && <span aria-hidden="true" className="rounded-full bg-destructive px-1 text-[10px] leading-4 text-white">{waiting}</span>}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="top" sideOffset={8} className="w-80 gap-3 p-3" aria-label="Network">
                <EgressSection client={client} open={open} />
                <div className="space-y-0.5">
                    <p className="text-xs font-medium">Port forwarding</p>
                    <p className="text-[10px] text-muted-foreground">Reach ports from your sessions on this computer.</p>
                </div>
                {requests.length > 0 && (
                    <div className="flex flex-col gap-3" aria-label="Port requests from agents" role="group">
                        <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Requested by agents</p>
                        {requests.map((item) => <PortRequestCard key={item.request.id} item={item} client={client} />)}
                        <Separator />
                    </div>
                )}
                <Previews links={links} client={client} sessionId={sessionId} />
                {!portForwardingSupported ? (
                    <p className="text-[10px] text-muted-foreground">Forwarding needs the Floq desktop app.</p>
                ) : (
                    <>
                        {count > 0 && (
                            <div className="flex flex-col gap-0.5">
                                <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Forwarded</p>
                                {forwardedPorts.map((port) => (
                                    <div key={port} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
                                        <span className="min-w-0 flex-1 truncate font-medium tabular-nums">:{port} <span className="font-normal text-muted-foreground"><IconChevronRight size={12} aria-hidden className="mr-0.5 inline align-[-1px]" />localhost:{port}</span></span>
                                        <Button type="button" variant="ghost" size="icon-xs" title="Open in browser" aria-label={`Open localhost:${port} in browser`} onClick={() => void openUrl(`http://localhost:${port}`)}>
                                            <IconExternalLink />
                                        </Button>
                                        <Button type="button" variant="ghost" size="icon-xs" title="Copy URL" aria-label={`Copy URL for port ${port}`} onClick={() => copyUrl(port)}>
                                            <IconCopy />
                                        </Button>
                                        <Button type="button" variant="ghost" size="icon-xs" title="Stop forwarding" aria-label={`Stop forwarding port ${port}`} onClick={() => void stopForward(port).then(() => toast.success(`Stopped forwarding localhost:${port}`, { description: "The port is no longer reachable from this computer." }))}>
                                            <IconX />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                        {detected.length > 0 && client && sessionId && (
                            <div className="flex flex-col gap-0.5">
                                <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Detected</p>
                                {detected.map(({ port }) => (
                                    <div key={port} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
                                        <span className="min-w-0 flex-1 truncate font-medium tabular-nums">:{port}</span>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="xs"
                                            onClick={() => void startForward(client, sessionId, port).then(() => toast.success(`Forwarding localhost:${port}`, { description: "Open it in a browser on this computer." }), (error) => toast.error(`Could not forward port ${port}`, { description: errorMessage(error) }))}
                                        >
                                            Forward
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                        {(count > 0 || detected.length > 0) && <Separator />}
                        <ManualForwardForm client={client} sessionId={sessionId} />
                    </>
                )}
            </PopoverContent>
        </Popover>
    );
}
