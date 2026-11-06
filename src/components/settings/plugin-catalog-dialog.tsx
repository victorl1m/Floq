import { useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconDownload, IconRefresh } from "@tabler/icons-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/app-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { PluginCatalogItem } from "@/lib/runtime/types";
import { ACTION_LABEL, TRUST_WARNING, confirmMatches, rowState, summarize, type CatalogAction } from "@/plugins/install-ui";
import { resolvePluginIcon } from "@/plugins/icons";
import { usePlugins } from "@/plugins/host";

const STATUS_BADGE = { builtin: "Built in", available: "", installed: "Installed", update: "Update available" } as const;

/** One compact catalog row. Presentational: the dialog owns the actions. */
export function CatalogRow({ item, busy, onAction }: { item: PluginCatalogItem; busy: boolean; onAction: (item: PluginCatalogItem, action: CatalogAction) => void }) {
    const state = rowState(item);
    const Icon = resolvePluginIcon(item.icon);
    return (
        <li data-plugin-catalog={item.id} data-state={state.status} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{item.name}</span>
                        <Badge variant="outline" className="font-mono">v{item.version}</Badge>
                        {STATUS_BADGE[state.status] && <Badge variant={state.status === "update" ? "default" : "secondary"}>{STATUS_BADGE[state.status]}</Badge>}
                        {state.status === "update" && <span className="text-xs text-muted-foreground">you have v{item.installedVersion}</span>}
                    </div>
                    {item.description && <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{item.description}</p>}
                    <ul className="space-y-0.5 text-xs text-muted-foreground">{summarize(item).map((line) => <li key={line}>{line}</li>)}</ul>
                </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                {state.actions.map((action) => (
                    <Button key={action} size="sm" variant={action === "install" || action === "update" ? "default" : action === "uninstall" ? "outline" : "ghost"} disabled={busy} onClick={() => onAction(item, action)}>
                        {action === "install" ? <IconDownload /> : action === "update" ? <IconRefresh /> : null}{ACTION_LABEL[action]}
                    </Button>
                ))}
            </div>
        </li>
    );
}

/** The confirmation body: the trust warning (install and update) and a field where the admin types the plugin id. */
export function ConfirmBody({ item, action, typed, onTyped }: { item: PluginCatalogItem; action: CatalogAction; typed: string; onTyped: (v: string) => void }) {
    const needsType = action !== "update";
    return (
        <div className="space-y-4" data-slot="plugin-confirm" data-action={action}>
            {(action === "install" || action === "update") && (
                <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>{TRUST_WARNING}</AlertDescription></Alert>
            )}
            {action === "uninstall" && <p className="text-sm text-muted-foreground">This turns {item.name} off, removes its MCP servers and skills for everyone, and deletes the installed package. Its data and settings are kept, so installing it again picks them up.</p>}
            {action === "purge" && <p className="text-sm text-muted-foreground">This permanently deletes everything {item.name} stored in Floq: its database schema, every user's settings for it and its migration history. This cannot be undone.</p>}
            {action === "update" && <p className="text-sm text-muted-foreground">Update to v{item.version}. If the new version fails to start, Floq goes back to v{item.installedVersion}.</p>}
            {needsType && (
                <div className="space-y-2">
                    <Label htmlFor="plugin-confirm-id">Type <code className="rounded bg-muted px-1 py-0.5 font-mono">{item.id}</code> to confirm</Label>
                    <Input id="plugin-confirm-id" value={typed} onChange={(e) => onTyped(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" aria-invalid={typed !== "" && !confirmMatches(typed, item.id) ? true : undefined} />
                </div>
            )}
        </div>
    );
}

/** Settings > Plugins > Browse plugins (administrators only). Install, update, uninstall and delete data from the floq-plugins catalog. */
export default function PluginCatalogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { client } = useRuntime();
    const { refresh } = usePlugins();
    const [items, setItems] = useState<PluginCatalogItem[] | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<{ item: PluginCatalogItem; action: CatalogAction } | null>(null);
    const [typed, setTyped] = useState("");

    const load = useCallback(async () => {
        if (!client) return;
        setError("");
        try { setItems(await client.pluginCatalog()); } catch (e) { setItems(null); setError(errorMessage(e)); }
    }, [client]);
    useEffect(() => { if (open) { setItems(null); void load(); } }, [open, load]);

    function ask(item: PluginCatalogItem, action: CatalogAction) { setTyped(""); setPending({ item, action }); }

    async function run() {
        if (!client || !pending) return;
        const { item, action } = pending;
        setBusy(true);
        try {
            if (action === "install") await client.installPlugin(item.id, typed.trim());
            else if (action === "update") await client.updatePlugin(item.id);
            else if (action === "uninstall") await client.uninstallPlugin(item.id, typed.trim());
            else await client.purgePluginData(item.id, typed.trim());
            toast.success(action === "install" ? `${item.name} installed` : action === "update" ? `${item.name} updated to v${item.version}` : action === "uninstall" ? `${item.name} uninstalled` : `${item.name} data deleted`,
                action === "install" ? { description: "It is off until you turn it on in the list." } : undefined);
            setPending(null);
            await Promise.all([refresh(), load()]);
        } catch (e) {
            toast.error(`Could not ${ACTION_LABEL[action].toLowerCase()} ${item.name}`, { description: errorMessage(e) });
        } finally { setBusy(false); }
    }

    const ok = pending ? (pending.action === "update" || confirmMatches(typed, pending.item.id)) : false;
    return (
        <>
            <AppDialog open={open && !pending} onOpenChange={onOpenChange} icon={<IconDownload />} title="Browse plugins" description="Plugins published in floq-plugins. Only administrators can install them." size="lg"
                footer={<Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>}>
                {error ? (
                    <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>
                ) : items === null ? <p role="status" className="text-sm text-muted-foreground">Loading the catalog…</p>
                : items.length === 0 ? <p className="text-sm text-muted-foreground">The catalog is empty.</p>
                : <ul aria-label="Plugin catalog" className="max-h-[50dvh] divide-y divide-border overflow-y-auto rounded-xl border border-border">{items.map((item) => <CatalogRow key={item.id} item={item} busy={busy} onAction={ask} />)}</ul>}
            </AppDialog>
            <AppDialog open={!!pending} onOpenChange={(o) => { if (!busy && !o) setPending(null); }} icon={<IconAlertTriangle />} size="md"
                title={pending ? `${ACTION_LABEL[pending.action]} ${pending.item.name}?` : ""}
                footer={<><Button variant="outline" disabled={busy} onClick={() => setPending(null)}>Cancel</Button><Button variant={pending?.action === "purge" || pending?.action === "uninstall" ? "destructive" : "default"} disabled={busy || !ok} onClick={() => void run()}>{busy ? "Working…" : pending ? ACTION_LABEL[pending.action] : ""}</Button></>}>
                {pending && <ConfirmBody item={pending.item} action={pending.action} typed={typed} onTyped={setTyped} />}
            </AppDialog>
        </>
    );
}
