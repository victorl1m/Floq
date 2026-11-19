import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAutoResumeOnClick } from "@/lib/prefs";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { UserSettings } from "@/lib/runtime/types";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";

interface Props {
    settings: UserSettings;
    onChange: (settings: UserSettings) => void;
}

export default function AdvancedSection({ settings, onChange }: Props) {
    const client = useClient();
    const [autoResume, setAutoResume] = useAutoResumeOnClick();

    /** Optimistic: flip locally, revert and toast if the server rejects it. */
    async function setCoauthor(value: boolean) {
        const previous = settings;
        onChange({ ...settings, gitCoauthor: value });
        try {
            onChange(await client.updateSettings({ gitCoauthor: value }));
        } catch (e) {
            onChange(previous);
            toast.error("Could not save settings", { description: errorMessage(e) });
        }
    }

    return (
        <SettingsPage title="Advanced" description="How Floq and the runtime behave on your behalf.">
            <SettingsGroup title="Sessions">
                <SettingRow settingId="advanced-auto-resume"
                    label="Resume sleeping agents when opened"
                    htmlFor="auto-resume-on-click"
                    description="Clicking a sleeping agent in the sidebar or a tab resumes it right away. Stored on this device only."
                >
                    <Switch id="auto-resume-on-click" checked={autoResume} onCheckedChange={setAutoResume} />
                </SettingRow>
            </SettingsGroup>
            {settings.gitCoauthor !== undefined && (
                <SettingsGroup>
                    <SettingRow settingId="advanced-coauthor"
                        label="Floq co-author on commits"
                        htmlFor="git-coauthor"
                        description={
                            settings.gitCoauthorAvailable === false ? (
                                "Disabled by the runtime."
                            ) : (
                                <>
                                    Adds <code>Co-authored-by: floqless &lt;floq@flowless.app&gt;</code> to commits made by Claude,
                                    Codex and terminals, replacing Claude Code&apos;s own co-author line.
                                </>
                            )
                        }
                    >
                        <Switch
                            id="git-coauthor"
                            checked={settings.gitCoauthor}
                            disabled={settings.gitCoauthorAvailable === false}
                            onCheckedChange={(v) => void setCoauthor(v)}
                        />
                    </SettingRow>
                </SettingsGroup>
            )}
        </SettingsPage>
    );
}
