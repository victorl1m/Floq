import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { useRuntime } from "@/lib/runtime/store";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import UpdatesGroup from "./updates-group";

export default function RuntimeSection() {
    const { baseUrl, info, online, requestServerChange } = useRuntime();

    return (
        <SettingsPage title="Runtime" description="The Floq Runtime server this app is connected to.">
            <SettingsGroup title="Connection">
                <SettingRow label="Server" description={<span className="font-mono break-all">{baseUrl}</span>}>
                    <Button variant="outline" size="sm" onClick={() => void requestServerChange()}>
                        Change server
                    </Button>
                </SettingRow>
                <SettingRow label="Status" description={online ? "Reachable" : "Can't reach the runtime. Retrying..."}>
                    <span
                        aria-label={online ? "Online" : "Offline"}
                        className={cn("size-2.5 rounded-full", online ? "bg-emerald-500" : "bg-destructive")}
                    />
                </SettingRow>
            </SettingsGroup>

            {info && (
                <>
                    <SettingsGroup title="Server">
                        <SettingRow label="Version">
                            <span className="text-sm text-muted-foreground">{info.server.version}</span>
                        </SettingRow>
                        <SettingRow label="Started">
                            <span className="text-sm text-muted-foreground">{new Date(info.server.startedAt).toLocaleString()}</span>
                        </SettingRow>
                        {info.server.timeZone && (
                            <SettingRow label="Time zone" description={`Server time zone: ${info.server.timeZone.zone} (${info.server.timeZone.source === "system" ? "from the server's clock" : "from " + info.server.timeZone.source})`}>
                                <span className="text-sm text-muted-foreground">{info.server.timeZone.zone}</span>
                            </SettingRow>
                        )}
                        <SettingRow label="Active sessions" description="Running terminals out of the server's limit.">
                            <span className="text-sm tabular-nums text-muted-foreground">
                                {info.server.activeSessions} / {info.server.maxSessions}
                            </span>
                        </SettingRow>
                    </SettingsGroup>

                    <SettingsGroup title="Providers">
                        {info.providers.map((provider) => (
                            <SettingRow
                                key={provider.id}
                                label={provider.label}
                                description={<span className="font-mono">{provider.command}</span>}
                            >
                                {provider.version && <span className="text-xs text-muted-foreground">{provider.version}</span>}
                                <Badge variant={provider.available ? "default" : "secondary"}>
                                    {provider.available ? "available" : "not found"}
                                </Badge>
                            </SettingRow>
                        ))}
                    </SettingsGroup>
                </>
            )}

            <UpdatesGroup />
        </SettingsPage>
    );
}
