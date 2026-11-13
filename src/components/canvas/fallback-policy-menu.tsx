import { useEffect, useState } from "react";
import { IconShieldHalf } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { errorMessage, useClient } from "@/lib/runtime/store";

type Policy = "default" | "model" | "pause";
const LABEL: Record<Policy, string> = { default: "Use default chain", model: "Model only", pause: "Pause instead" };

/** Per-agent usage-limit policy (agent card header). The account switch is user-wide, so it is not a per-agent choice. */
export function FallbackPolicyMenu({ sessionId, value }: { sessionId: string; value: "model" | "pause" | null | undefined }) {
    const client = useClient();
    const [saved, setSaved] = useState<Policy | null>(null);
    // The server value wins again as soon as it changes (another tab, the recruit flag).
    useEffect(() => { setSaved(null); }, [value]);
    const current: Policy = saved ?? value ?? "default";

    async function choose(next: string) {
        const policy = next as Policy;
        setSaved(policy);
        try {
            await client.fallbackAction(sessionId, "override", policy);
        } catch (e) {
            setSaved(null);
            toast.error("Could not save the usage-limit policy", { description: errorMessage(e) });
        }
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7" aria-label={`Usage-limit fallback: ${LABEL[current]}`} title={`Usage-limit fallback: ${LABEL[current]}`} data-policy={current}>
                    <IconShieldHalf size={14} className={current === "default" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"} />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="nodrag nopan w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">When this agent hits a Claude usage limit</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={current} onValueChange={(v) => void choose(v)}>
                    {(Object.keys(LABEL) as Policy[]).map((policy) => <DropdownMenuRadioItem key={policy} value={policy}>{LABEL[policy]}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
