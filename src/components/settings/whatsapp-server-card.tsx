import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { useIsAdmin } from "./use-admin";
import type { WhatsappServerHealth, WhatsappServerState, WhatsappServerStatus } from "@/lib/runtime/admin-types";

const DOT: Record<WhatsappServerState, string> = {
    off: "bg-muted-foreground/40",
    starting: "bg-amber-500",
    unreachable: "bg-destructive",
    unauthorized: "bg-destructive",
    running: "bg-emerald-500",
};

function stateText(s: WhatsappServerStatus["builtin"]): string {
    switch (s.state) {
        case "running": return `Running${s.version ? ` ${s.version}` : ""}${s.engine ? `, ${s.engine}` : ""}`;
        case "starting": return "Starting";
        case "unreachable": return "Not reachable";
        case "unauthorized": return "Key mismatch";
        default: return "Off";
    }
}

export const WHATSAPP_NOTICE = "WhatsApp is linked through WAHA, an unofficial client. WhatsApp may restrict or ban numbers that send spam or bulk messages. Use it for normal conversations.";

/** Settings > Integrations > WhatsApp (administrators): the Floq-managed WAHA server this runtime runs for the plugin. */
export function WhatsappServerCard() {
    const { client } = useRuntime();
    const isAdmin = useIsAdmin();
    const [status, setStatus] = useState<WhatsappServerStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [health, setHealth] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        if (!client || !isAdmin) return;
        let live = true;
        client.whatsappServer().then((s) => { if (live) setStatus(s); }, () => undefined);
        return () => { live = false; };
    }, [client, isAdmin]);

    const check = useCallback(async () => {
        if (!client) return;
        setChecking(true);
        setHealth(null);
        try {
            const h: WhatsappServerHealth = await client.whatsappServerHealth();
            setHealth({ ok: h.ok, text: h.ok ? `Healthy${h.latencyMs != null ? `, answered in ${h.latencyMs} ms` : ""}` : `Not healthy (${h.state === "unauthorized" ? "key mismatch" : h.state})` });
            setStatus((s) => (s ? { ...s, builtin: { ...s.builtin, state: h.state, version: h.version ?? s.builtin.version } } : s));
        } catch (e) {
            setHealth({ ok: false, text: `Health check failed: ${errorMessage(e)}` });
        } finally {
            setChecking(false);
        }
    }, [client]);

    if (!isAdmin || !status?.builtin.enabled) return null;
    const { builtin, plugin } = status;
    const inUse = plugin.mode !== "external";
    return (
        <div data-slot="whatsapp-server-card" className="space-y-3 rounded-xl border border-border bg-muted/30 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Built-in WhatsApp server</span>
                <Badge variant={inUse ? "secondary" : "outline"} data-slot="whatsapp-server-use">
                    {inUse ? "In use" : "Not used: WhatsApp points at an external WAHA address"}
                </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${DOT[builtin.state]}`} aria-hidden />
                <span data-slot="whatsapp-server-state">{stateText(builtin)}</span>
                {builtin.error && <span className="text-destructive">{builtin.error}</span>}
                <span className="ml-auto flex items-center gap-2">
                    {health && <span role="status" className={health.ok ? "text-muted-foreground" : "text-destructive"}>{health.text}</span>}
                    <Button variant="outline" size="xs" disabled={checking} onClick={() => void check()}>
                        {checking && <Spinner />}
                        Check health
                    </Button>
                </span>
            </div>
            <p className="text-muted-foreground">To use an external WAHA instead, choose "Use another server" above; disconnecting it returns to this built-in server.</p>
            <p className="text-muted-foreground">{WHATSAPP_NOTICE}</p>
            <p className="text-muted-foreground">
                <a className="underline underline-offset-2 hover:text-foreground" href="https://github.com/devlikeapro/waha" target="_blank" rel="noreferrer">Powered by WAHA Core (Apache-2.0)</a>
            </p>
        </div>
    );
}
