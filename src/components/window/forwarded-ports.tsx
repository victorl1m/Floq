import { useState } from "react";
import { IconCopy, IconExternalLink, IconPlugConnected, IconX } from "@tabler/icons-react";
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
import { portForwardingSupported, startForward, stopForward, usePortForwarding } from "@/lib/port-forwarding";

function copyUrl(port: number) {
    navigator.clipboard.writeText(`http://localhost:${port}`).then(
        () => toast.success("URL copied", { description: "It is on your clipboard." }),
        () => toast.error("Could not copy the URL", { description: "The browser blocked clipboard access." }),
    );
}

/** Footer indicator with the count of forwarded ports; its popover lists them and offers manual forwarding. */
export function ForwardedPorts() {
    const [open, setOpen] = useState(false);
    const { forwarded, ports } = usePortForwarding();
    const { client, sessionId } = useActiveForwardSession();
    const forwardedPorts = Object.keys(forwarded).map(Number).sort((a, b) => a - b);
    const count = forwardedPorts.length;
    const detected = (sessionId ? ports[sessionId] ?? [] : []).filter(({ port }) => !forwarded[port]);
    const requests = usePortRequests();
    const waiting = requests.filter((item) => item.state === "pending").length;
    const label = `Ports: ${count} forwarded${waiting ? `, ${waiting} request${waiting === 1 ? "" : "s"} waiting for your answer` : ""}`;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="xs"
                    type="button"
                    title={label}
                    aria-label={label}
                    className={cn("-mr-2 ml-2 gap-1.5 px-2 text-[11px] tabular-nums", count === 0 && !waiting && "opacity-60", open && "bg-muted text-foreground")}
                >
                    <IconPlugConnected size={12} stroke={1.5} aria-hidden="true" />
                    <span>Ports</span>
                    <span>{count}</span>
                    {waiting > 0 && <span aria-hidden="true" className="rounded-full bg-destructive px-1 text-[10px] leading-4 text-white">{waiting}</span>}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="top" sideOffset={8} className="w-80 gap-3 p-3">
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
                {!portForwardingSupported ? (
                    <p className="text-[10px] text-muted-foreground">Forwarding needs the Floq desktop app.</p>
                ) : (
                    <>
                        {count > 0 && (
                            <div className="flex flex-col gap-0.5">
                                <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Forwarded</p>
                                {forwardedPorts.map((port) => (
                                    <div key={port} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50">
                                        <span className="min-w-0 flex-1 truncate font-medium tabular-nums">:{port} <span className="font-normal text-muted-foreground">→ localhost:{port}</span></span>
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
