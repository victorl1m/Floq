import { useState } from "react";
import { IconHistory } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import type { AgentConversation, SessionSummary } from "@/lib/runtime/types";

const ENDED: Record<string, string> = { fresh_start: "Ended by Start fresh", provider_switch: "Provider switched", switched: "Switched away", superseded: "Replaced" };

export function conversationLabel(c: AgentConversation): string {
    return c.current ? "Current" : (c.endedReason && ENDED[c.endedReason]) || "Earlier";
}

/** Conversation history of one agent: switch back to an earlier conversation, or start fresh (the current one is kept). */
export function ConversationHistoryMenu({ session }: { session: SessionSummary }) {
    const client = useClient();
    const { upsertSession } = useRuntime();
    const [items, setItems] = useState<AgentConversation[] | null>(null);
    const [busy, setBusy] = useState(false);

    async function load(open: boolean) {
        if (!open) return;
        try { setItems(await client.listConversations(session.id)); }
        catch (e) { setItems([]); toast.error("Could not load the conversation history", { description: errorMessage(e) }); }
    }
    async function run(action: () => Promise<SessionSummary>, failure: string) {
        setBusy(true);
        try { upsertSession(await action()); }
        catch (e) { toast.error(failure, { description: errorMessage(e) }); }
        finally { setBusy(false); }
    }

    const others = (items ?? []).filter((c) => c.provider === session.provider);
    return (
        <DropdownMenu onOpenChange={(open) => void load(open)}>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7" aria-label={`Conversation history of ${session.title}`} title="Conversation history" disabled={busy}>
                    <IconHistory size={14} className="text-muted-foreground" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="nodrag nopan w-72">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Conversation history</DropdownMenuLabel>
                {items === null && <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>}
                {items !== null && others.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No conversations recorded yet.</div>}
                {others.map((c) => (
                    <DropdownMenuItem key={c.id} disabled={c.current || busy} onSelect={() => void run(() => client.switchConversation(session.id, c.id), "Could not switch conversation")}>
                        <div className="flex min-w-0 flex-col">
                            <span className="truncate text-xs">{conversationLabel(c)} · {new Date(c.startedAt).toLocaleString()}</span>
                            <span className="truncate font-mono text-[10px] text-muted-foreground">{c.providerSessionId}</span>
                            {!c.current && <span className="text-[10px] text-muted-foreground">Switch to this conversation</span>}
                        </div>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy} onSelect={() => void run(() => client.startFresh(session.id), "Could not start fresh")}>
                    Start fresh (keeps the current conversation)
                </DropdownMenuItem>
                {(session.provider === "claude" || session.provider === "codex") && (
                    <DropdownMenuItem disabled={busy} onSelect={() => void run(() => client.startFresh(session.id, { summary: true }), "Could not start fresh with a summary")}>
                        <div className="flex min-w-0 flex-col">
                            <span className="text-xs">Start fresh with summary</span>
                            <span className="text-[10px] text-muted-foreground">New conversation whose first prompt recaps the old one</span>
                        </div>
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Action on the "couldn't resume" notice: explicit, never automatic. A new conversation whose first prompt recaps the old transcript. */
export function StartFreshWithSummaryButton({ session }: { session: SessionSummary }) {
    const client = useClient();
    const { upsertSession } = useRuntime();
    const [busy, setBusy] = useState(false);
    async function go() {
        setBusy(true);
        try { upsertSession(await client.startFresh(session.id, { summary: true })); }
        catch (e) { toast.error("Could not start fresh with a summary", { description: errorMessage(e) }); }
        finally { setBusy(false); }
    }
    return (
        <Button type="button" size="xs" variant="secondary" className="nodrag nopan" disabled={busy} title="New conversation; the first prompt summarizes the old one. The old conversation stays in the history." onClick={() => void go()}>
            Start fresh with summary
        </Button>
    );
}
