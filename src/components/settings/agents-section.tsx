import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/agents/provider";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { ProviderId, SettingsPatch, UserSettings } from "@/lib/runtime/types";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";

interface Props {
    settings: UserSettings;
    onChange: (settings: UserSettings) => void;
}

export default function AgentsSection({ settings, onChange }: Props) {
    const client = useClient();
    const [defaults, setDefaults] = useState(loadComposerPrefs);

    function setDefaultProvider(provider: ProviderId) {
        const next = { ...defaults, provider };
        setDefaults(next);
        saveComposerPrefs(next);
    }
    /** Optimistic: flip locally, revert and toast if the server rejects it. */
    async function patch(update: SettingsPatch & Partial<UserSettings>) {
        const previous = settings;
        onChange({ ...settings, ...update } as UserSettings);
        try {
            onChange(await client.updateSettings(update));
        } catch (e) {
            onChange(previous);
            toast.error("Could not save settings", { description: errorMessage(e) });
        }
    }

    return (
        <SettingsPage title="Agents" description="How new agents start. Defaults are stored on this device.">
            <SettingsGroup title="Defaults">
                <SettingRow label="Default agent" htmlFor="default-agent-provider" description="Preselected in the Home composer.">
                    <Select value={defaults.provider} onValueChange={(v) => setDefaultProvider(v as ProviderId)}>
                        <SelectTrigger id="default-agent-provider" className="w-40">
                            <SelectValue><ProviderIcon provider={defaults.provider} />{PROVIDER_LABEL[defaults.provider]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="claude"><ProviderIcon provider="claude" />{PROVIDER_LABEL.claude}</SelectItem>
                            <SelectItem value="codex"><ProviderIcon provider="codex" />{PROVIDER_LABEL.codex}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Permissions">
                <SettingRow
                    label="Claude auto-approve"
                    htmlFor="claude-auto"
                    description={
                        <>
                            Launches Claude Code with <code>--dangerously-skip-permissions</code>, so it runs tools without asking.
                            Applies to new and resumed sessions.
                        </>
                    }
                >
                    <Switch
                        id="claude-auto"
                        checked={settings.claudeAutoApprove}
                        onCheckedChange={(v) => void patch({ claudeAutoApprove: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Codex auto-approve"
                    htmlFor="codex-auto"
                    description={
                        <>
                            Launches Codex with <code>--dangerously-bypass-approvals-and-sandbox</code>, so it runs commands without
                            approval or sandboxing. Applies to new and resumed sessions.
                        </>
                    }
                >
                    <Switch
                        id="codex-auto"
                        checked={settings.codexAutoApprove}
                        onCheckedChange={(v) => void patch({ codexAutoApprove: v })}
                    />
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
