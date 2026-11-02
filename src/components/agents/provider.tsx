import { IconTerminal2 } from "@tabler/icons-react";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import type { ProviderId, SessionState } from "@/lib/runtime/types";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
    claude: "Claude Code",
    codex: "Codex",
    shell: "Terminal",
};

export function ProviderIcon({ provider, className }: { provider: ProviderId; className?: string }) {
    const Icon = provider === "claude" ? IconBrandClaude : provider === "shell" ? IconTerminal2 : IconBrandCodex;
    return <Icon className={cn("size-4 shrink-0", className)} aria-label={PROVIDER_LABEL[provider]} />;
}

export function isLive(state: SessionState): boolean {
    return state === "running" || state === "starting";
}

export function StateBadge({ state, className }: { state: SessionState; className?: string }) {
    const variant = state === "failed" ? "destructive" : state === "running" ? "default" : "secondary";
    return (
        <Badge variant={variant} className={cn("h-4 px-1.5 text-[10px]", className)}>
            {state}
        </Badge>
    );
}
