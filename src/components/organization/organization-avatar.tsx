import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { orgIconSvg, orgMonogram } from "@/lib/org-icon";
import { useRuntime } from "@/lib/runtime/store";
import type { RuntimeClient } from "@/lib/runtime/client";

/** One object URL per image URL (it carries a version, so a changed image is a new key). Bounded so it cannot grow without end. */
const cache = new Map<string, Promise<string>>();
const CACHE_LIMIT = 32;

function loadImage(client: RuntimeClient, imageUrl: string): Promise<string> {
    let found = cache.get(imageUrl);
    if (!found) {
        found = client.organizationImage(imageUrl).then((blob) => URL.createObjectURL(blob));
        found.catch(() => cache.delete(imageUrl));
        cache.set(imageUrl, found);
        if (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) { const stale = cache.get(oldest); cache.delete(oldest); void stale?.then((url) => URL.revokeObjectURL(url), () => undefined); }
        }
    }
    return found;
}

/** Local preview (object URL / data URL) wins; otherwise the authenticated image fetched from the runtime. Null until it loads or on failure. */
function useImageSrc(imageUrl: string | null | undefined, preview?: string | null): string | null {
    const { client } = useRuntime();
    const [src, setSrc] = useState<string | null>(null);
    useEffect(() => {
        setSrc(null);
        if (preview || !imageUrl || !client) return;
        let current = true;
        loadImage(client, imageUrl).then((url) => { if (current) setSrc(url); }, () => undefined);
        return () => { current = false; };
    }, [client, imageUrl, preview]);
    return preview ?? src;
}

/**
 * Rounded-square avatar: the organization image when it has one, else a generated "signboard" icon (colour, motif and turn picked
 * from `seed`, the organization id, so a rename keeps it; the name only gives the monogram). `compact` draws one letter instead of
 * up to two (small rows). Decorative; the name is always rendered next to it.
 */
export function OrganizationAvatar({ name, seed, imageUrl, preview, compact, className }: { name: string; seed?: string | null; imageUrl?: string | null; preview?: string | null; compact?: boolean; className?: string }) {
    const src = useImageSrc(imageUrl, preview);
    const svg = useMemo(() => orgIconSvg(seed ?? name, { monogram: orgMonogram(name, compact ? 1 : 2) }), [seed, name, compact]);
    return (
        <Avatar
            aria-hidden="true"
            data-testid="org-avatar"
            data-has-image={src ? "true" : "false"}
            className={cn("size-8 rounded-lg after:hidden ring-1 ring-foreground/10", className)}
        >
            {src ? <AvatarImage src={src} alt="" draggable={false} className="rounded-[inherit]" /> : null}
            <AvatarFallback delayMs={0} className="rounded-[inherit] overflow-hidden bg-transparent">
                <span className="block size-full" dangerouslySetInnerHTML={{ __html: svg }} />
            </AvatarFallback>
        </Avatar>
    );
}
