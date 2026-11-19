import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { checkForUpdates, currentVersion, installAndRestart, updaterSupported, useUpdateState } from "@/lib/updater";
import { releaseNotesUrl } from "@/lib/updater-logic";
import { openExternal } from "@/lib/open-external";
import { useAutoUpdate } from "@/lib/prefs";
import { SettingRow, SettingsGroup } from "./ui";

/** Desktop app updates (signed in-app updater): check now, restart into a downloaded version, automatic updates. */
export default function AppUpdatesGroup() {
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

    if (!updaterSupported()) return null;
    return (
        <SettingsGroup title="Updates">
            <SettingRow settingId="about-app-update"
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
            <SettingRow settingId="about-auto-update"
                label="Update automatically"
                htmlFor="auto-update"
                description="Checks shortly after launch and every 6 hours, and downloads in the background. You choose when to restart. Stored on this device only."
            >
                <Switch id="auto-update" checked={autoUpdate} onCheckedChange={setAutoUpdate} />
            </SettingRow>
        </SettingsGroup>
    );
}
