import { useLayoutEffect, useRef } from "react";
import { ProviderIcon } from "@/components/agents/provider";
import { useAvatarPreference } from "@/lib/avatar-preference";
import { robotAvatarSvg } from "@/lib/robot-avatar";
import { cn } from "cn";
import type { ProviderId } from "@/lib/runtime/types";

/** First opaque background behind `el`, so the badge ring matches whatever surface the avatar sits on. */
function surfaceColor(el: HTMLElement | null): string | null {
    for (let node = el?.parentElement; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return null;
}

/**
 * Agent identity: a seeded Floq blob with eyes (from the session UUID) and the provider as a small badge
 * tucked fully inside the bottom-right corner, ringed in the surrounding surface colour so it never smudges
 * the eyes. Settings > Appearance > Robot avatars off shows the provider logo alone.
 */
export function AgentAvatar({ session, size = 20, className }: { session: { id: string; provider: ProviderId }; size?: number; className?: string }) {
    const [pref] = useAvatarPreference();
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const color = surfaceColor(ref.current);
        if (color) ref.current?.style.setProperty("--avatar-ring", color);
    });
    if (pref !== "on") return <ProviderIcon provider={session.provider} className={className} style={{ width: size, height: size }} />;
    const badge = Math.max(6, Math.round(size * 0.38));
    const ring = size >= 32 ? 2 : size >= 20 ? 1.5 : 1;
    return (
        <span ref={ref} data-agent-avatar={session.id} className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
            <span className="block size-full" dangerouslySetInnerHTML={{ __html: robotAvatarSvg(session.id, size >= 24) }} />
            <span data-avatar-badge="" className="absolute right-0 bottom-0 grid place-items-center rounded-full bg-[var(--avatar-ring,var(--card))]"
                style={{ width: badge, height: badge, padding: ring }}>
                <ProviderIcon provider={session.provider} className="size-full" />
            </span>
        </span>
    );
}
