import { useEffect, useState } from "react";
import { cn } from "cn";
import { organizationInitials } from "@/lib/organizations";
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

/** Rounded-square tile: the organization image when it has one, else its initials (decorative; the name is always rendered next to it). */
export function OrganizationAvatar({ name, imageUrl, preview, className }: { name: string; imageUrl?: string | null; preview?: string | null; className?: string }) {
    const src = useImageSrc(imageUrl, preview);
    return (
        <span
            aria-hidden="true"
            data-testid="org-avatar"
            data-has-image={src ? "true" : "false"}
            className={cn("flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-xs font-semibold text-foreground ring-1 ring-foreground/10", className)}
        >
            {src ? <img src={src} alt="" draggable={false} className="size-full object-cover" /> : organizationInitials(name)}
        </span>
    );
}
