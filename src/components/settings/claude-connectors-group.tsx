import { useCallback, useEffect, useState } from "react";
import { IconExternalLink } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { openExternal } from "@/lib/open-external";
import { useClient } from "@/lib/runtime/store";
import type { ClaudeConnectors, ConnectorDiagnostic } from "@/lib/runtime/types";
import ClaudeOAuthDialog from "./claude-oauth-dialog";
import { SettingRow, SettingsGroup } from "./ui";

const MANAGE_URL = "https://claude.ai/settings/connectors";

const DIAGNOSTIC_TEXT: Record<ConnectorDiagnostic, string> = {
    api_key: "Claude is signed in with an API key: connectors are off. Remove the API key to use claude.ai connectors.",
    needs_signin: "Sign in to Claude again to grant connector access.",
    missing_scope: "Sign in to Claude again to grant connector access.",
};

/** Settings > Agents: the claude.ai connectors toggle, why the list may be empty, and the read-only list. */
export default function ClaudeConnectorsGroup({ enabled, onToggle }: { enabled: boolean; onToggle: (on: boolean) => void }) {
    const client = useClient();
    const [data, setData] = useState<ClaudeConnectors | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [signIn, setSignIn] = useState(false);

    const load = useCallback(
        async (refresh = false) => {
            setLoading(true);
            try {
                setData(await client.claudeConnectors(refresh));
                setFailed(false);
            } catch {
                // Older runtime or an undocumented upstream: the toggle still works.
                setFailed(true);
            } finally {
                setLoading(false);
            }
        },
        [client],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const needsSignIn = data?.diagnostics.some((d) => d === "needs_signin" || d === "missing_scope") ?? false;
    const couldNotLoad = failed || data?.error === "unavailable";

    return (
        <SettingsGroup title="claude.ai connectors">
            <SettingRow settingId="accounts-connectors"
                label="Use my claude.ai connectors"
                htmlFor="claude-connectors"
                description="Claude agents can use the connectors you added at claude.ai (mail, drive, calendar and so on), with the access you granted there. Applies to new or restarted Claude sessions. Codex sessions do not use claude.ai connectors."
            >
                <Switch id="claude-connectors" checked={enabled} onCheckedChange={onToggle} />
            </SettingRow>
            <div className="flex flex-col gap-2 px-4 py-3 text-sm">
                {data?.diagnostics.map((d, i) => (
                    <p key={d + i} className="text-amber-600 dark:text-amber-400" role="status">
                        {DIAGNOSTIC_TEXT[d]}
                    </p>
                ))}
                {needsSignIn && (
                    <div>
                        <Button size="sm" variant="outline" onClick={() => setSignIn(true)}>
                            Sign in to Claude
                        </Button>
                    </div>
                )}
                {loading && !data && (
                    <p className="flex items-center gap-2 text-muted-foreground">
                        <Spinner /> Loading connectors
                    </p>
                )}
                {couldNotLoad && <p className="text-muted-foreground">Couldn't load the connector list. The toggle above still applies.</p>}
                {data && !couldNotLoad && !needsSignIn && (
                    data.connectors.length === 0 ? (
                        <p className="text-muted-foreground">No connectors found on your claude.ai account.</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {data.connectors.map((c) => (
                                <li key={c.name} className="flex items-center justify-between gap-3 py-1.5">
                                    <span className="min-w-0 truncate">{c.displayName}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {c.host ? c.host + " · " : ""}
                                        {c.connected ? "connected" : "not connected"}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )
                )}
                <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" variant="ghost" onClick={() => void load(true)} disabled={loading}>
                        Refresh
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void openExternal(MANAGE_URL)}>
                        Manage at claude.ai → Settings → Connectors <IconExternalLink className="size-3.5" />
                    </Button>
                </div>
            </div>
            <ClaudeOAuthDialog
                open={signIn}
                onOpenChange={setSignIn}
                onConnected={() => void load(true)}
                onUnsupported={() => {
                    setSignIn(false);
                    toast.error("Sign in from Settings > Accounts instead");
                }}
            />
        </SettingsGroup>
    );
}
