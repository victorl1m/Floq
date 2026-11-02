import type { LoginProviderId } from "@/lib/runtime/types";
import { useProviderStatus } from "@/components/settings/use-provider-status";
import { useRuntime } from "@/lib/runtime/store";

const ALL: LoginProviderId[] = ["claude", "codex"];

/** Providers the user can actually start: connected (per /v1/providers/status) and available (per /v1/info). */
export function useUsableProviders() {
    const { info } = useRuntime();
    const { status, unsupported, reload } = useProviderStatus();

    const available = (id: LoginProviderId) =>
        !info || (Boolean(info.providers.find((p) => p.id === id)?.available) && info.server.providers.includes(id));
    // Older runtimes have no status endpoint: don't block anything there.
    const connected = (id: LoginProviderId) => unsupported || status?.[id].connected === true;

    const loading = status === null && !unsupported;
    const usable = loading ? [] : ALL.filter((id) => available(id) && connected(id));
    const hasMissing = !loading && !unsupported && ALL.some((id) => !connected(id));

    return { loading, usable, hasMissing, reload };
}
