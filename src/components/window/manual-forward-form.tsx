import { useState } from "react";
import { IconHistory } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { startForward, usePortForwarding } from "@/lib/port-forwarding";

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Session the footer and Ports tab act on: the active session or terminal, like ActivePortWatcher. */
export function useActiveForwardSession(): { client: RuntimeClient | null; sessionId: string | null } {
    const { client, view, selectedId, selectedTerminalId } = useRuntime();
    return { client, sessionId: view === "terminal" ? selectedTerminalId : view === "session" ? selectedId : null };
}

/** The parsed port, or an inline error message. */
function validate(value: string, forwarded: Record<number, string>, sessionId: string): { port: number } | { error: string } {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return { error: "Enter a port number." };
    const port = Number(text);
    if (port < MIN_PORT || port > MAX_PORT) return { error: `Port must be between ${MIN_PORT} and ${MAX_PORT}.` };
    const owner = forwarded[port];
    if (owner === sessionId) return { error: `Port ${port} is already forwarded.` };
    if (owner) return { error: `Port ${port} is forwarded from another session.` };
    return { port };
}

/** Manual port forward: works for ports the runtime has not detected (the tunnel is requested with ?manual=1). */
export function ManualForwardForm({ client, sessionId }: { client: RuntimeClient | null; sessionId: string | null }) {
    const { forwarded } = usePortForwarding();
    const { userPreferences, updateUserPreferences } = useRuntime();
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const disabled = !client || !sessionId;
    const recent = (sessionId ? userPreferences.recentForwardPorts[sessionId] : undefined)?.filter((port) => !forwarded[port]) ?? [];

    async function submit(raw: string) {
        if (!client || !sessionId || busy) return;
        const result = validate(raw, forwarded, sessionId);
        if ("error" in result) { setError(result.error); return; }
        setBusy(true);
        setError(null);
        try {
            await startForward(client, sessionId, result.port, true);
            const others = (userPreferences.recentForwardPorts[sessionId] ?? []).filter((port) => port !== result.port);
            updateUserPreferences({ recentForwardPorts: { ...userPreferences.recentForwardPorts, [sessionId]: [result.port, ...others].slice(0, 5) } });
            setValue("");
            toast.success(`Forwarding localhost:${result.port}`);
        } catch (failure) {
            setError(errorMessage(failure));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => { event.preventDefault(); void submit(value); }}
        >
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Forward a port</p>
            <div className="flex items-center gap-1.5">
                <Input
                    inputMode="numeric"
                    placeholder="Port (e.g. 3000)"
                    aria-label="Port to forward"
                    aria-invalid={error ? true : undefined}
                    disabled={disabled || busy}
                    value={value}
                    maxLength={5}
                    onChange={(event) => { setValue(event.target.value.replace(/\D/g, "")); setError(null); }}
                    className="h-7 flex-1 text-xs tabular-nums md:text-xs"
                />
                <Button type="submit" size="xs" disabled={disabled || busy || !value}>
                    {busy ? "Forwarding…" : "Forward"}
                </Button>
            </div>
            {error && <p role="alert" className="text-[10px] text-destructive">{error}</p>}
            {disabled && <p className="text-[10px] text-muted-foreground">Open a session or terminal to forward one of its ports.</p>}
            {!disabled && !error && <p className="text-[10px] text-muted-foreground">Reaches 127.0.0.1 on the machine running the session. Connections fail until something listens.</p>}
            {recent.length > 0 && !disabled && (
                <div className="flex flex-wrap items-center gap-1">
                    <IconHistory size={11} className="text-muted-foreground" />
                    {recent.map((port) => (
                        <button
                            key={port}
                            type="button"
                            disabled={busy}
                            title={`Forward localhost:${port} again`}
                            onClick={() => void submit(String(port))}
                            className="h-4 cursor-pointer rounded bg-muted/60 px-1.5 text-[11px] tabular-nums outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                        >
                            :{port}
                        </button>
                    ))}
                </div>
            )}
        </form>
    );
}
