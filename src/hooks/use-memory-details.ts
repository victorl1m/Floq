import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type ProcessMemory = {
    pid: number;
    name: string;
    memory: number;
    isMain: boolean;
};

export type MemoryDetails = {
    total: number;
    systemTotal: number;
    systemUsed: number;
    processes: ProcessMemory[];
};

const MEMORY_POLL_INTERVAL_MS = 2000;

export function useMemoryDetails() {
    const [details, setDetails] = useState<MemoryDetails | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [hasError, setHasError] = useState(false);
    const mounted = useRef(true);

    const fetchDetails = useCallback(async () => {
        if (!isTauri() || document.visibilityState === "hidden") return;

        try {
            const next = await invoke<MemoryDetails>("get_memory_details");
            if (!mounted.current) return;

            setDetails(next);
            setHasError(false);
        } catch {
            if (mounted.current) setHasError(true);
        }
    }, []);

    const refresh = useCallback(async () => {
        setIsRefreshing(true);
        await fetchDetails();
        if (mounted.current) setIsRefreshing(false);
    }, [fetchDetails]);

    useEffect(() => {
        mounted.current = true;

        if (!isTauri()) {
            return () => {
                mounted.current = false;
            };
        }

        void fetchDetails();
        const interval = window.setInterval(
            fetchDetails,
            MEMORY_POLL_INTERVAL_MS,
        );

        return () => {
            mounted.current = false;
            window.clearInterval(interval);
        };
    }, [fetchDetails]);

    return { details, isRefreshing, hasError, refresh };
}
