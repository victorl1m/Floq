import IconBrandFloq from "@/components/ui/brand/IconBrandFloq";
import pkg from "../../../package.json";
import IconBrandFlowless from "@/components/ui/brand/IconBrandFlowless";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useRuntime } from "@/lib/runtime/store";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import AppUpdatesGroup from "./app-updates-group";

export default function AboutSection() {
    const { info } = useRuntime();

    return (
        <SettingsPage title="About" description="Version information and app updates.">
            <SettingsGroup>
                <div className="flex items-center gap-3 p-4">
                    <IconBrandFloq size={36} variant="brand" />
                    <div className="flex flex-col">
                        <span className="font-medium">Floq</span>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            Powered by <IconBrandFlowless size={12} /> Flowless
                        </span>
                    </div>
                </div>
                <SettingRow label="Website" description="floq.flowless.app">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            const url = "https://floq.flowless.app";
                            if (isTauri()) void openUrl(url);
                            else window.open(url, "_blank", "noopener,noreferrer");
                        }}
                    >
                        Open
                    </Button>
                </SettingRow>
                <SettingRow label="App version">
                    <span className="text-sm text-muted-foreground">{pkg.version || "—"}</span>
                </SettingRow>
                <SettingRow label="Runtime version">
                    <span className="text-sm text-muted-foreground">{info?.server.version || "—"}</span>
                </SettingRow>
            </SettingsGroup>
            <AppUpdatesGroup />
        </SettingsPage>
    );
}
