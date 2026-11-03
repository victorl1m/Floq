import { IconPlugConnected, IconX } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { stopForward, usePortForwarding } from "@/lib/port-forwarding";

/** Footer chips for ports currently forwarded to this machine; renders nothing when there are none. */
export function ForwardedPorts() {
    const { forwarded } = usePortForwarding();
    const ports = Object.keys(forwarded).map(Number).sort((a, b) => a - b);
    if (ports.length === 0) return null;

    return (
        <div className="ml-3 flex min-w-0 items-center gap-1.5" title="Forwarded ports">
            <IconPlugConnected size={12} stroke={1.5} className="shrink-0" />
            {ports.map((port) => (
                <span key={port} className="inline-flex h-4 items-center rounded bg-muted/60 text-[11px] tabular-nums">
                    <button
                        type="button"
                        title={`Open localhost:${port} in browser`}
                        aria-label={`Open localhost:${port} in browser`}
                        onClick={() => void openUrl(`http://localhost:${port}`)}
                        className="h-4 cursor-pointer rounded-l pr-0.5 pl-1.5 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        :{port}
                    </button>
                    <button
                        type="button"
                        title={`Stop forwarding :${port}`}
                        aria-label={`Stop forwarding port ${port}`}
                        onClick={() => void stopForward(port).then(() => toast.success(`Stopped forwarding localhost:${port}`))}
                        className="flex h-4 cursor-pointer items-center rounded-r px-1 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        <IconX size={10} />
                    </button>
                </span>
            ))}
        </div>
    );
}
