import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { checkForUpdates, currentVersion, installAndRestart, updaterSupported, useUpdateState } from "@/lib/updater";
import { releaseNotesUrl } from "@/lib/updater-logic";
import { openExternal } from "@/lib/open-external";
import { Switch } from "@/components/ui/switch";
import { useAutoResumeOnClick, useAutoUpdate } from "@/lib/prefs";
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
    const [autoUpdate, setAutoUpdate] = useAutoUpdate();
    const update = useUpdateState();
    const [version, setVersion] = useState<string | null>(null);
    useEffect(() => { void currentVersion().then(setVersion); }, []);
    const busy = update.status === "checking" || update.status === "downloading" || update.status === "installing";
    const updateText =
        update.status === "checking" ? "Checking for updates…"
        : update.status === "downloading" ? `Downloading Floq ${update.version}${update.progress !== null ? ` (${Math.round(update.progress * 100)}%)` : "…"}`
        : update.status === "ready" ? `Floq ${update.version} is ready to install.`
        : update.status === "installing" ? "Installing…"
        : update.status === "uptodate" ? "Floq is up to date."
        : update.status === "error" ? (update.error ?? "Could not check for updates.")
        : null;

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
            {updaterSupported() && (
                <SettingsGroup title="Updates">
                    <SettingRow settingId="advanced-updates"
                        label={`Floq ${version ?? ""}`.trim()}
                        description={
                            <>
                                {updateText ?? "Updates are verified with a signature before they are installed."}
                                {update.version && (
                                    <>
                                        {" "}
                                        <button type="button" className="underline underline-offset-2" onClick={() => void openExternal(releaseNotesUrl(update.version!))}>
                                            Release notes
                                        </button>
                                    </>
                                )}
                            </>
                        }
                    >
                        {update.status === "ready" ? (
                            <Button size="sm" onClick={() => void installAndRestart()}>Restart now</Button>
                        ) : (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void checkForUpdates(true)}>
                                Check for updates
                            </Button>
                        )}
                    </SettingRow>
                    <SettingRow settingId="advanced-auto-update"
                        label="Update automatically"
                        htmlFor="auto-update"
                        description="Checks shortly after launch and every 6 hours, and downloads in the background. You choose when to restart. Stored on this device only."
                    >
                        <Switch id="auto-update" checked={autoUpdate} onCheckedChange={setAutoUpdate} />
                    </SettingRow>
                </SettingsGroup>
            )}
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
