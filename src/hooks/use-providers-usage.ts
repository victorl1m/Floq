import { useCallback, useEffect, useState } from "react";
import { RuntimeError } from "@/lib/runtime/client";
import { useRuntime } from "@/lib/runtime/store";
import type { ProvidersUsage } from "@/lib/runtime/types";

const POLL_MS = 60_000;

/** Subscription usage limits. Polls every 60s while visible; `unsupported` when the runtime has no endpoint. */
export function useProvidersUsage() {
    const { client } = useRuntime();
    const [usage, setUsage] = useState<ProvidersUsage | null>(null);
    const [unsupported, setUnsupported] = useState(false);
    const [isRefreshing, setRefreshing] = useState(false);

    const refresh = useCallback(async () => {
        if (!client) return;
        setRefreshing(true);
        try {
            setUsage(await client.providersUsage());
            setUnsupported(false);
        } catch (e) {
            if (e instanceof RuntimeError && (e.status === 404 || e.status === 405)) setUnsupported(true);
        } finally {
            setRefreshing(false);
        }
    }, [client]);

    useEffect(() => {
        if (!client) {
            setUsage(null);
            return;
        }
        void refresh();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
        }, POLL_MS);
        const onVisible = () => document.visibilityState === "visible" && void refresh();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [client, refresh]);

    return { usage, unsupported, isRefreshing, refresh };
}
