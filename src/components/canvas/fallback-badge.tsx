import { useState } from "react";
import { IconArrowBackUp, IconPlayerPause, IconSwitchHorizontal } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { SessionFallback } from "@/lib/runtime/types";

function resetText(resetsAt: string | null): string | null {
    if (!resetsAt) return null;
    const date = new Date(resetsAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function fallbackBadgeText(fallback: SessionFallback): string {
    const reset = resetText(fallback.resetsAt);
    return fallback.kind === "paused" ? `Paused${reset ? ` · ${reset}` : ""}` : `Fallback: ${fallback.label}`;
}

/** Card badge for an agent on a usage-limit fallback. The popover explains it and offers Return now / Keep. */
export function FallbackBadge({ sessionId, fallback }: { sessionId: string; fallback: SessionFallback }) {
    const client = useClient();
    const [busy, setBusy] = useState(false);
    const reset = resetText(fallback.resetsAt);
    const paused = fallback.kind === "paused";

    async function act(action: "return" | "keep") {
        setBusy(true);
        try {
            const result = await client.fallbackAction(sessionId, action);
            if (!result.applied) {
                if (result.reason === "still_limited") toast.warning("Your usage limit is still on", { description: `Switching back now would be blocked again${resetText(result.resetsAt ?? null) ? ` (resets ${resetText(result.resetsAt ?? null)})` : ""}. Floq switches back by itself at the reset.` });
                else toast.info("Nothing to change", { description: "This agent is no longer on a fallback." });
                return;
            }
            if (action === "keep") toast.info("Staying on " + fallback.label, { description: "Floq will not switch this agent back automatically." });
        } catch (e) {
            toast.error("Could not update the agent", { description: errorMessage(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="nodrag nopan inline-flex shrink-0 items-center rounded-md leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70" aria-label={fallbackBadgeText(fallback)}>
                    <Badge
                        variant="outline"
                        data-testid="fallback-badge"
                        data-kind={fallback.kind}
                        className={paused ? "h-4 gap-0.5 px-1.5 text-[10px] font-normal text-muted-foreground" : "h-4 gap-0.5 border-amber-500/50 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-400"}
                    >
                        {paused ? <IconPlayerPause size={10} aria-hidden="true" /> : <IconSwitchHorizontal size={10} aria-hidden="true" />}
                        {fallbackBadgeText(fallback)}
                    </Badge>
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 text-xs" align="start">
                <p className="font-medium">{paused ? "Paused: usage limit reached" : fallback.kind === "account" ? `Running on your ${fallback.label} Claude account` : `Running on ${fallback.label}`}</p>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                    {paused ? "This agent is waiting for your Claude usage limit to reset" : fallback.kind === "account" ? "Your main Claude account reached a usage limit; all your Claude agents use the other account" : fallback.kind === "codex" ? "A Claude usage limit was reached; Codex continues this task from a handoff summary (a new conversation, same agent)" : `A Claude usage limit was reached while on ${fallback.originLabel}`}
                    {reset ? ` (resets ${reset}).` : "."}{" "}
                    {paused ? "It continues on its own then." : fallback.keep ? "It will stay as it is." : fallback.kind === "account" ? "Your main account comes back when its limit resets." : fallback.kind === "codex" ? "It returns to Claude when the limit resets." : `It switches back to ${fallback.originLabel} when the limit resets.`}
                </p>
                <div className="mt-3 flex gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act("return")}>
                        <IconArrowBackUp aria-hidden="true" />{paused ? "Resume now" : "Return now"}
                    </Button>
                    {!paused && !fallback.keep && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void act("keep")}>Keep</Button>}
                </div>
            </PopoverContent>
        </Popover>
    );
}
