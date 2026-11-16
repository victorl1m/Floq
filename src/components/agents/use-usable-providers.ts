import type { LoginProviderId, ProviderId } from "@/lib/runtime/types";
import { useProviderStatus } from "@/components/settings/use-provider-status";
import { useRuntime } from "@/lib/runtime/store";

/** Subscription logins the user must have (Antigravity's Google login is optional, see below). */
const LOGIN: LoginProviderId[] = ["claude", "codex"];
/** API-key / env-var providers (credentials come from the vault): usable whenever the runtime reports the CLI. */
const KEYED: ProviderId[] = ["opencode"];

/** Providers the user can actually start: connected (per /v1/providers/status) and available (per /v1/info). */
export function useUsableProviders() {
    const { info } = useRuntime();
    const { status, unsupported, reload } = useProviderStatus();

    const available = (id: ProviderId) =>
        !info || (Boolean(info.providers.find((p) => p.id === id)?.available) && info.server.providers.includes(id));
    // Older runtimes have no status endpoint: don't block anything there.
    const connected = (id: LoginProviderId) => unsupported || status?.[id]?.connected === true;
    const agy = info?.providers.find((p) => p.id === "antigravity");
    // The live status wins over /v1/info (which is only refreshed every few minutes).
    const agyLogin = status?.antigravity ? status.antigravity.connected : agy?.oauthConnected === true;
    // Antigravity works with a Google login OR a GEMINI_API_KEY in the vault; it is optional, so it never counts as "missing".
    const agyUsable = Boolean(info) && available("antigravity") && (agy?.apiKeyConfigured !== false || agyLogin);

    const loading = status === null && !unsupported;
    const usable: ProviderId[] = loading
        ? []
        : [
              ...LOGIN.filter((id) => available(id) && connected(id)),
              ...KEYED.filter((id) => Boolean(info) && available(id) && info?.providers.find((p) => p.id === id)?.apiKeyConfigured !== false),
              ...(agyUsable ? (["antigravity"] as ProviderId[]) : []),
          ];
    const hasMissing = !loading && !unsupported && LOGIN.some((id) => !connected(id));

    return { loading, usable, hasMissing, reload };
}
