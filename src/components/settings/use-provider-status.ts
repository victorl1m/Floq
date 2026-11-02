import { useCallback, useEffect, useState } from "react";
import { RuntimeError } from "@/lib/runtime/client";
import { useRuntime } from "@/lib/runtime/store";
import type { ProvidersStatus } from "@/lib/runtime/types";

/** Subscription login status for Claude / Codex. `unsupported` when the runtime has no such endpoint (404). */
export function useProviderStatus() {
    const { client } = useRuntime();
    const [status, setStatus] = useState<ProvidersStatus | null>(null);
    const [unsupported, setUnsupported] = useState(false);

    const reload = useCallback(async () => {
        if (!client) return;
        try {
            setStatus(await client.providersStatus());
            setUnsupported(false);
        } catch (e) {
            if (e instanceof RuntimeError && (e.status === 404 || e.status === 405)) setUnsupported(true);
        }
    }, [client]);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { status, unsupported, reload };
}
