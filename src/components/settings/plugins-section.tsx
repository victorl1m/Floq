import { useCallback, useEffect, useState } from "react";
import { IconChevronDown, IconDownload } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { PluginInfo, PluginSecretMigration, PluginSettingValues, PluginStatus } from "@/lib/runtime/types";
import { PluginBoundary, usePlugins } from "@/plugins/host";
import { resolvePluginIcon } from "@/plugins/icons";
import { PluginSettingsForm } from "@/plugins/kit/plugin-settings-form";
import { useIsAdmin } from "./use-admin";
import PluginCatalogDialog from "./plugin-catalog-dialog";
import { MigrationNotice, PluginCredentials } from "./plugin-credentials";
import { SettingsGroup, SettingsPage } from "./ui";

const STATUS: Record<PluginStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
    available: { label: "Off", variant: "outline" },
    disabled: { label: "Off", variant: "outline" },
    enabled: { label: "On", variant: "secondary" },
    failed: { label: "Failed", variant: "destructive" },
    invalid: { label: "Invalid", variant: "destructive" },
};

function PluginConfig({ plugin, isAdmin }: { plugin: PluginInfo; isAdmin: boolean }) {
    const { client } = useRuntime();
    const { ui, refresh } = usePlugins();
    const [values, setValues] = useState<PluginSettingValues | null>(null);
    const [loadError, setLoadError] = useState("");
    // Install-scope configuration is administrator-only on the server; everyone else only sees credential presence.
    const readable = plugin.scope === "user" || isAdmin;
    const load = useCallback(async () => {
        if (!client || !readable) return;
        setLoadError("");
        try { setValues(await client.getPluginSettings(plugin.id)); } catch (e) { setLoadError(errorMessage(e)); }
    }, [client, plugin.id, readable]);
    useEffect(() => { void load(); }, [load]);
    const Panel = plugin.contributes.settingsPanel ? ui[plugin.id]?.settingsPanel : undefined;

    return (
        <div className="space-y-5 border-t border-border p-4" data-slot="plugin-config">
            <PluginCredentials plugin={plugin} isAdmin={isAdmin} api={client} onChanged={() => void refresh()} />
            {!readable ? <p className="text-sm text-muted-foreground">This plugin is configured by an administrator.</p>
                : loadError ? <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{loadError}</p><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>
                : !values ? <p role="status" className="text-sm text-muted-foreground">Loading settings…</p>
                : (
                    <PluginSettingsForm
                        pluginId={plugin.id} decls={plugin.settings} values={values}
                        onSave={async (next) => { if (!client) return; setValues(await client.savePluginSettings(plugin.id, next)); toast.success(`${plugin.name} settings saved`); }}
                    />
                )}
            {Panel && <PluginBoundary pluginId={plugin.id}><Panel plugin={plugin} /></PluginBoundary>}
        </div>
    );
}

export function PluginRow({ plugin, isAdmin, busy, onToggleInstall, onToggleUser }: {
    plugin: PluginInfo; isAdmin: boolean; busy: boolean;
    onToggleInstall: (on: boolean) => void; onToggleUser: (on: boolean) => void;
}) {
    const [open, setOpen] = useState(false);
    const Icon = resolvePluginIcon(plugin.icon);
    const status = STATUS[plugin.status];
    const invalid = plugin.status === "invalid";
    const regionId = `plugin-config-${plugin.id}`;
    return (
        <div data-plugin={plugin.id} data-status={plugin.status}>
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-1 gap-3">
                    <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{plugin.name}</span>
                            {plugin.version && <Badge variant="outline" className="font-mono">v{plugin.version}</Badge>}
                            <Badge variant={status.variant}>{status.label}</Badge>
                            {plugin.scope === "install" && <Badge variant="outline">Whole runtime</Badge>}
                            {plugin.source === "installed" && <Badge variant="outline">Installed</Badge>}
                        </div>
                        {plugin.description && <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{plugin.description}</p>}
                        {invalid && <p role="alert" className="text-xs text-destructive">{plugin.error ?? "Its manifest is invalid."}</p>}
                        {plugin.status === "failed" && <p className="text-xs text-destructive">It failed to start. An administrator can turn it on again to retry.</p>}
                    </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-4 sm:justify-end">
                    {isAdmin && !invalid && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            {plugin.scope === "install" ? "Enabled" : "Available"}
                            <Switch checked={plugin.enabled} disabled={busy} aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name} for this runtime`} onCheckedChange={onToggleInstall} />
                        </label>
                    )}
                    {plugin.scope === "user" && plugin.enabled && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            On for me
                            <Switch checked={plugin.userEnabled} disabled={busy} aria-label={`Use ${plugin.name}`} onCheckedChange={onToggleUser} />
                        </label>
                    )}
                    {!invalid && (
                        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
                            Configure <IconChevronDown className={open ? "rotate-180" : undefined} />
                        </Button>
                    )}
                </div>
            </div>
            {open && !invalid && <div id={regionId}><PluginConfig plugin={plugin} isAdmin={isAdmin} /></div>}
        </div>
    );
}

/** Settings > Plugins: every plugin with version and status; admins enable or disable, each user switches user-scoped plugins on. */
export default function PluginsSection() {
    const { client } = useRuntime();
    const { all, loading, refresh } = usePlugins();
    const isAdmin = useIsAdmin();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [browsing, setBrowsing] = useState(false);
    const [migrations, setMigrations] = useState<PluginSecretMigration[]>([]);

    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => {
        if (!client) return;
        let live = true;
        client.getPluginSecretMigrations().then((items) => { if (live) setMigrations(items); }, () => undefined);
        return () => { live = false; };
    }, [client]);
    async function dismissMigrations() {
        setMigrations([]);
        try { await client?.dismissPluginSecretMigrations(); } catch { /* the notice just returns next time */ }
    }

    async function toggle(plugin: PluginInfo, on: boolean, level: "install" | "user") {
        if (!client) return;
        setBusyId(plugin.id);
        try {
            const result = await client.setPluginEnabled(plugin.id, on, level);
            await refresh();
            const problems = result.mcpProblems;
            if (problems.length) toast.warning(`${plugin.name} ${on ? "turned on" : "turned off"}, with problems`, { description: problems.join(" ") });
            else toast.success(`${plugin.name} ${on ? "turned on" : "turned off"}`);
        } catch (e) {
            toast.error(`Could not ${on ? "turn on" : "turn off"} ${plugin.name}`, { description: errorMessage(e) });
        } finally {
            setBusyId(null);
        }
    }

    return (
        <SettingsPage title="Plugins" description="Plugins add screens, task sources and integrations to Floq. Each plugin keeps its own credentials, separate from Secrets.">
            <MigrationNotice items={migrations} onDismiss={() => void dismissMigrations()} />
            {isAdmin && (
                <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setBrowsing(true)}><IconDownload /> Browse plugins</Button>
                </div>
            )}
            <SettingsGroup>
                {loading && !all.length && <div role="status" className="p-4 text-sm text-muted-foreground">Loading plugins…</div>}
                {!loading && !all.length && <div className="p-4 text-sm text-muted-foreground">No plugins are installed on this runtime.</div>}
                {all.map((plugin) => (
                    <PluginRow
                        key={plugin.id} plugin={plugin} isAdmin={isAdmin} busy={busyId === plugin.id}
                        onToggleInstall={(on) => void toggle(plugin, on, "install")}
                        onToggleUser={(on) => void toggle(plugin, on, "user")}
                    />
                ))}
            </SettingsGroup>
            {isAdmin && <PluginCatalogDialog open={browsing} onOpenChange={setBrowsing} />}
        </SettingsPage>
    );
}
