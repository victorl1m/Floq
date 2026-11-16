import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import IconBrandClaude from "@/components/ui/brand/IconBrandClaude";
import IconBrandCodex from "@/components/ui/brand/IconBrandCodex";
import IconBrandAntigravity from "@/components/ui/brand/IconBrandAntigravity";
import { cn } from "cn";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { ProviderIcon } from "@/components/agents/provider";
import type { LoginProviderId, UserSettings } from "@/lib/runtime/types";
import ConnectProviderDialog from "./connect-provider-dialog";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import { ClaudeAccountsGroup } from "./claude-accounts-group";
import { UsageFallbackGroup } from "./usage-fallback-group";
import { useSettingsPatch } from "./use-settings-patch";
import { useProviderStatus } from "./use-provider-status";

const PROVIDERS: { id: LoginProviderId; label: string; subtitle: string }[] = [
    { id: "claude", label: "Claude", subtitle: "Claude Pro / Max subscription" },
    { id: "codex", label: "Codex", subtitle: "ChatGPT subscription" },
    { id: "antigravity", label: "Antigravity", subtitle: "Google account (Gemini subscription)" },
];

const KEYED_PROVIDERS: { id: "opencode" | "antigravity"; label: string; subtitle: string }[] = [
    { id: "opencode", label: "OpenCode", subtitle: "Uses an API key stored in your vault (Settings > Vault)" },
    { id: "antigravity", label: "Antigravity", subtitle: "Or sign in with Google above. An API key (GEMINI_API_KEY) stored in your vault also works" },
];

export default function AccountsSection({ settings, onChange }: { settings: UserSettings; onChange: (settings: UserSettings) => void }) {
    const client = useClient();
    const { info } = useRuntime();
    const patch = useSettingsPatch(settings, onChange);
    const { status, unsupported, reload } = useProviderStatus();
    const [connecting, setConnecting] = useState<LoginProviderId | null>(null);
    const [busy, setBusy] = useState<LoginProviderId | null>(null);

    async function disconnect(id: LoginProviderId) {
        setBusy(id);
        try {
            await client.providerLogout(id);
            window.dispatchEvent(new Event("floq:vault-changed")); // re-read /v1/info (Antigravity usability)
            toast.success("Disconnected", { description: "Sign in again to use this account." });
            await reload();
        } catch (e) {
            toast.error("Could not disconnect", { description: errorMessage(e) });
        } finally {
            setBusy(null);
        }
    }

    return (
        <SettingsPage title="LLM Providers" description="Agents sign in with your own subscriptions. No API keys needed.">
            {unsupported && <p className="text-sm text-muted-foreground">Your runtime doesn't support this yet.</p>}
            <SettingsGroup>
                {PROVIDERS.filter((p) => p.id !== "antigravity" || info?.providers.find((i) => i.id === "antigravity")?.available === true).map((p) => {
                    const connected = status?.[p.id]?.connected ?? false;
                    return (
                        <SettingRow
                            key={p.id}
                            settingId={p.id === "antigravity" ? "accounts-antigravity-google" : undefined}
                            label={
                                <span className="flex items-center gap-2">
                                    {p.id === "claude" ? <IconBrandClaude size={18} /> : p.id === "antigravity" ? <IconBrandAntigravity size={18} /> : <IconBrandCodex size={18} />}
                                    {p.label}
                                </span>
                            }
                            description={
                                <span className="flex flex-col gap-1">
                                    {p.subtitle}
                                    <span className="flex items-center gap-1.5">
                                        <span
                                            className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/40")}
                                        />
                                        {status ? (connected ? "Connected" + (status[p.id]?.plan ? " · " + status[p.id]?.plan : "") : "Not connected") : "Checking..."}
                                    </span>
                                </span>
                            }
                        >
                            {connected ? (
                                <Button variant="outline" size="sm" disabled={busy === p.id} onClick={() => void disconnect(p.id)}>
                                    {busy === p.id && <Spinner />}
                                    Disconnect
                                </Button>
                            ) : (
                                <Button size="sm" disabled={!status || unsupported} onClick={() => setConnecting(p.id)}>
                                    {p.id === "antigravity" ? "Sign in with Google" : "Connect"}
                                </Button>
                            )}
                        </SettingRow>
                    );
                })}
            </SettingsGroup>
            <SettingsGroup title="API-key agents">
                {KEYED_PROVIDERS.map((p) => {
                    const available = info?.providers.find((i) => i.id === p.id)?.available === true;
                    return (
                        <SettingRow
                            key={p.id}
                            label={<span className="flex items-center gap-2"><ProviderIcon provider={p.id} className="size-[18px]" />{p.label}</span>}
                            description={
                                <span className="flex flex-col gap-1">
                                    {p.subtitle}
                                    <span className="flex items-center gap-1.5">
                                        <span className={cn("size-2 rounded-full", available ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                                        {!info ? "Checking..." : available ? "Installed" : "Not installed on this runtime"}
                                    </span>
                                </span>
                            }
                        />
                    );
                })}
            </SettingsGroup>
            {status?.claude.connected && !unsupported && <ClaudeAccountsGroup onChanged={() => void reload()} />}
            <UsageFallbackGroup settings={settings} patch={patch} />
            {connecting && (
                <ConnectProviderDialog
                    provider={connecting}
                    open
                    onOpenChange={(open) => !open && setConnecting(null)}
                    onConnected={() => { void reload(); window.dispatchEvent(new Event("floq:vault-changed")); }}
                />
            )}
        </SettingsPage>
    );
}
