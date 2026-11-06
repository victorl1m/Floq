import { useCallback, useEffect, useState } from "react";
import { IconChevronDown, IconDownload, IconKey } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { PluginInfo, PluginSettingValues, PluginStatus } from "@/lib/runtime/types";
import { PluginBoundary, usePlugins } from "@/plugins/host";
import { resolvePluginIcon } from "@/plugins/icons";
import { PluginSettingsForm } from "@/plugins/kit/plugin-settings-form";
import { useIsAdmin } from "./use-admin";
import PluginCatalogDialog from "./plugin-catalog-dialog";
import { SettingsGroup, SettingsPage } from "./ui";

const STATUS: Record<PluginStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
    available: { label: "Off", variant: "outline" },
    disabled: { label: "Off", variant: "outline" },
    enabled: { label: "On", variant: "secondary" },
    failed: { label: "Failed", variant: "destructive" },
    invalid: { label: "Invalid", variant: "destructive" },
};

export function SecretsStatus({ plugin, onOpenSecrets, isAdmin = true }: { plugin: PluginInfo; onOpenSecrets: () => void; isAdmin?: boolean }) {
    // Install-scope secrets live in the enabling administrator's vault: other users can only ask for them.
    const adminOwned = plugin.scope === "install" && !isAdmin;
    if (!plugin.secrets.length) return null;
    const missing = plugin.secrets.filter((s) => !s.present);
    return (
        <div className="space-y-2" data-slot="plugin-secrets">
            <div className="text-xs font-medium text-muted-foreground">Secrets</div>
            <ul className="space-y-1.5">
                {plugin.secrets.map((s) => (
                    <li key={s.name} className="flex flex-wrap items-center gap-2 text-xs">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{s.name}</code>
                        <Badge variant={s.present ? "secondary" : s.required ? "destructive" : "outline"}>{s.present ? "Present" : "Missing"}</Badge>
                        {!s.required && !s.present && <span className="text-muted-foreground">optional</span>}
                        {s.description && <span className="text-muted-foreground">{s.description}</span>}
                    </li>
                ))}
            </ul>
            {missing.length > 0 && (adminOwned
                ? <p className="text-xs text-muted-foreground">An administrator needs to add {missing.map((s) => s.name).join(", ")}.</p>
                : <Button variant="outline" size="sm" onClick={onOpenSecrets}><IconKey /> Open Secrets</Button>)}
            <p className="text-xs text-muted-foreground">Floq only shows whether a secret exists. Values are never displayed here.</p>
        </div>
    );
}

function PluginConfig({ plugin, isAdmin, onOpenSecrets }: { plugin: PluginInfo; isAdmin: boolean; onOpenSecrets: () => void }) {
    const { client } = useRuntime();
    const { ui } = usePlugins();
    const [values, setValues] = useState<PluginSettingValues | null>(null);
    const [loadError, setLoadError] = useState("");
    // Install-scope configuration is administrator-only on the server; everyone else only sees the secret status.
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
            <SecretsStatus plugin={plugin} onOpenSecrets={onOpenSecrets} isAdmin={isAdmin} />
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

export function PluginRow({ plugin, isAdmin, busy, onToggleInstall, onToggleUser, onOpenSecrets }: {
    plugin: PluginInfo; isAdmin: boolean; busy: boolean;
    onToggleInstall: (on: boolean) => void; onToggleUser: (on: boolean) => void; onOpenSecrets: () => void;
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
            {open && !invalid && <div id={regionId}><PluginConfig plugin={plugin} isAdmin={isAdmin} onOpenSecrets={onOpenSecrets} /></div>}
        </div>
    );
}

/** Settings > Plugins: every plugin with version and status; admins enable or disable, each user switches user-scoped plugins on. */
export default function PluginsSection() {
    const { client, setSettingsOpen } = useRuntime();
    const { all, loading, refresh, openSecrets } = usePlugins();
    const isAdmin = useIsAdmin();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [browsing, setBrowsing] = useState(false);

    useEffect(() => { void refresh(); }, [refresh]);

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
        <SettingsPage title="Plugins" description="Plugins add screens, task sources and integrations to Floq. Credentials stay in Secrets and are referenced by name.">
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
                        onOpenSecrets={() => { setSettingsOpen(false); openSecrets(); }}
                    />
                ))}
            </SettingsGroup>
            {isAdmin && <PluginCatalogDialog open={browsing} onOpenChange={setBrowsing} />}
        </SettingsPage>
    );
}
