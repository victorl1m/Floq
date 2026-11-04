import { useRef, useState } from "react";
import { IconHistory } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { startForward, usePortForwarding } from "@/lib/port-forwarding";
import { useRightSidebar } from "@/lib/right-sidebar";
import { isLive } from "@/components/agents/provider";
import type { SessionSummary } from "@/lib/runtime/types";

/** Title of the lightweight home shell created when a manual forward has no running session to go through. */
export const FORWARD_SHELL_TITLE = "Port forwarding";

/** A running session to tunnel through when none is active: the port-forwarding shell, else the newest live session. */
function pickForwardSession(sessions: SessionSummary[]): SessionSummary | null {
    const live = sessions.filter((session) => isLive(session.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return live.find((session) => session.provider === "shell" && session.title === FORWARD_SHELL_TITLE) ?? live[0] ?? null;
}

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Session the footer ports control acts on: the active session or terminal, or the agent selected on the canvas. */
export function useActiveForwardSession(): { client: RuntimeClient | null; sessionId: string | null } {
    const { client, view, selectedId, selectedTerminalId } = useRuntime();
    const { canvasSessionId } = useRightSidebar();
    return { client, sessionId: view === "terminal" ? selectedTerminalId : view === "session" ? selectedId : view === "canvas" ? canvasSessionId : null };
}

/** The parsed port, or an inline error message. */
function validate(value: string, forwarded: Record<number, string>, sessionId: string | null): { port: number } | { error: string } {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return { error: "Enter a port number." };
    const port = Number(text);
    if (port < MIN_PORT || port > MAX_PORT) return { error: `Port must be between ${MIN_PORT} and ${MAX_PORT}.` };
    const owner = forwarded[port];
    if (owner === sessionId) return { error: `Port ${port} is already forwarded.` };
    if (owner) return { error: `Port ${port} is forwarded from another session.` };
    return { port };
}

/**
 * Manual port forward: works for ports the runtime has not detected (the tunnel is requested with ?manual=1).
 * The tunnel endpoint is scoped to a live session (auth and ownership), so with no active session the form
 * falls back to a running one, and failing that opens a home shell titled "Port forwarding". No session needs
 * to be open first.
 */
export function ManualForwardForm({ client, sessionId }: { client: RuntimeClient | null; sessionId: string | null }) {
    const { forwarded } = usePortForwarding();
    const { userPreferences, updateUserPreferences, sessions, upsertSession } = useRuntime();
    const preparing = useRef(false);
    const [status, setStatus] = useState<string | null>(null);
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const disabled = !client;
    const recentKey = sessionId ?? pickForwardSession(sessions)?.id ?? null;
    const recent = (recentKey ? userPreferences.recentForwardPorts[recentKey] : undefined)?.filter((port) => !forwarded[port]) ?? [];

    /** The session to tunnel through: the active one, a running one, or a freshly created home shell. */
    async function resolveSession(runtime: RuntimeClient): Promise<string> {
        if (sessionId) return sessionId;
        const existing = pickForwardSession(sessions);
        if (existing) return existing.id;
        setStatus("Preparing a shell…");
        const created = await runtime.createSession({ provider: "shell", title: FORWARD_SHELL_TITLE, home: true });
        upsertSession(created);
        return created.id;
    }

    async function submit(raw: string) {
        if (!client || busy || preparing.current) return;
        const result = validate(raw, forwarded, recentKey);
        if ("error" in result) { setError(result.error); return; }
        preparing.current = true;
        setBusy(true);
        setError(null);
        try {
            let target: string;
            try { target = await resolveSession(client); } catch (failure) { throw new Error(`Could not prepare a shell to forward through: ${errorMessage(failure)}`); }
            setStatus(null);
            await startForward(client, target, result.port, true);
            const others = (userPreferences.recentForwardPorts[target] ?? []).filter((port) => port !== result.port);
            updateUserPreferences({ recentForwardPorts: { ...userPreferences.recentForwardPorts, [target]: [result.port, ...others].slice(0, 5) } });
            setValue("");
            toast.success(`Forwarding localhost:${result.port}`);
        } catch (failure) {
            setError(errorMessage(failure));
        } finally {
            preparing.current = false;
            setStatus(null);
            setBusy(false);
        }
    }

    return (
        <form
            noValidate
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
                    aria-busy={busy || undefined}
                    value={value}
                    maxLength={5}
                    onChange={(event) => { setValue(event.target.value.replace(/\D/g, "")); setError(null); }}
                    className="h-7 flex-1 text-xs tabular-nums md:text-xs"
                />
                <Button type="submit" size="xs" disabled={disabled || busy || !value}>
                    {busy ? "Forwarding…" : "Forward"}
                </Button>
            </div>
            <div aria-live="polite" role="status" className="empty:hidden">
                {status && <p className="text-[10px] text-muted-foreground">{status}</p>}
            </div>
            {error && <p role="alert" className="text-[10px] text-destructive">{error}</p>}
            {!error && !status && <p className="text-[10px] text-muted-foreground">Forwards to localhost:PORT on this computer. Connections fail until something listens.</p>}
            {recent.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                    <IconHistory size={11} className="text-muted-foreground" />
                    {recent.map((port) => (
                        <Button variant="ghost" size="xs"
                            key={port}
                            type="button"
                            disabled={busy}
                            title={`Forward localhost:${port} again`}
                            onClick={() => void submit(String(port))}
                            className="h-5 bg-muted/60 px-1.5 text-[11px] tabular-nums"
                        >
                            :{port}
                        </Button>
                    ))}
                </div>
            )}
        </form>
    );
}
