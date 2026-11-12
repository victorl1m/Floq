import { ProviderIcon } from "@/components/agents/provider";
import { useAvatarPreference } from "@/lib/avatar-preference";
import { useRobotAvatar } from "@/lib/robot-avatar";
import { cn } from "cn";
import type { ProviderId } from "@/lib/runtime/types";

/**
 * Agent identity: a generated robot (seeded by the session UUID) in a rounded square, with the provider
 * as a tiny corner badge. Settings > Appearance > Robot avatars off, or a still-loading avatar, shows the provider logo.
 */
export function AgentAvatar({ session, size = 20, className }: { session: { id: string; provider: ProviderId }; size?: number; className?: string }) {
    const [pref] = useAvatarPreference();
    const uri = useRobotAvatar(session.id, pref === "on");
    if (!uri) return <ProviderIcon provider={session.provider} className={className} style={{ width: size, height: size }} />;
    const badge = Math.max(9, Math.round(size * 0.5));
    return (
        <span data-agent-avatar={session.id} className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
            <img src={uri} alt="" draggable={false} className="size-full rounded-[28%] bg-muted object-cover ring-1 ring-border/70 dark:brightness-90" />
            <span className="absolute -right-[3px] -bottom-[3px] grid place-items-center rounded-full bg-card ring-1 ring-border" style={{ width: badge, height: badge }}>
                <ProviderIcon provider={session.provider} className="size-full p-px" />
            </span>
        </span>
    );
}
