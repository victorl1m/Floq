import { useCallback, useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconDownload, IconRefresh, IconSearch } from "@tabler/icons-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/app-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { PluginCatalogItem, PluginRepoPreview } from "@/lib/runtime/types";
import { ACTION_LABEL, FILTER_LABEL, REPO_TRUST_WARNING, TRUST_WARNING, avatarUrl, categoryOf, confirmMatches, filterCatalog, matchesFilter, repoOf, type CatalogFilter, previewLines, rowState, summarize, type CatalogAction } from "@/plugins/install-ui";
import { resolvePluginIcon } from "@/plugins/icons";
import { usePlugins } from "@/plugins/host";
import { cn } from "cn";

const STATUS_BADGE = { builtin: "Built in", available: "", installed: "Installed", update: "Update available" } as const;

/** Repo avatar tile: the catalog icon when it names a known Tabler icon, else the GitHub owner avatar, else the first letter. */
export function PluginMark({ item, className }: { item: PluginCatalogItem; className?: string }) {
    const url = avatarUrl(item);
    const Icon = resolvePluginIcon(item.icon);
    // An icon name this client does not know (newer catalog) falls back to the repo avatar, not the generic plug.
    const knownIcon = !!item.icon && Icon !== resolvePluginIcon(undefined);
    return (
        <Avatar data-slot="plugin-mark" className={cn("size-12 rounded-xl after:rounded-xl", className)}>
            {url && !knownIcon && <AvatarImage src={url} alt="" referrerPolicy="no-referrer" className="rounded-xl" />}
            <AvatarFallback className="rounded-xl bg-muted text-base font-semibold text-muted-foreground">
                {knownIcon ? <Icon className="size-6" /> : (item.name[0] ?? "?").toUpperCase()}
            </AvatarFallback>
        </Avatar>
    );
}

/** One grid card of the explorer. A button, so Enter/Space select it. */
export function CatalogCard({ item, selected, onSelect }: { item: PluginCatalogItem; selected: boolean; onSelect: (id: string) => void }) {
    const state = rowState(item);
    return (
        <li className="min-w-0">
            <button type="button" data-plugin-card={item.id} data-state={state.status} aria-pressed={selected} onClick={() => onSelect(item.id)}
                className={cn("flex h-full w-full min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected ? "border-primary ring-1 ring-primary" : "border-border")}>
                <div className="flex min-w-0 items-start gap-3">
                    <PluginMark item={item} />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">v{item.version}{repoOf(item) ? ` · ${repoOf(item)}` : ""}</p>
                    </div>
                </div>
                <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">{item.description || "No description."}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{categoryOf(item)}</Badge>
                    {STATUS_BADGE[state.status] && <Badge variant={state.status === "update" ? "default" : "secondary"}>{STATUS_BADGE[state.status]}</Badge>}
                </div>
            </button>
        </li>
    );
}

/** The detail pane of the selected plugin (kept as `CatalogRow`). Presentational: the dialog owns the actions. */
export function CatalogRow({ item, busy, onAction }: { item: PluginCatalogItem; busy: boolean; onAction: (item: PluginCatalogItem, action: CatalogAction) => void }) {
    const state = rowState(item);
    return (
        <div data-plugin-catalog={item.id} data-state={state.status} className="flex flex-col gap-4">
            <div className="flex min-w-0 flex-1 gap-3">
                <PluginMark item={item} className="size-14" />
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold">{item.name}</h3>
                        <Badge variant="outline" className="font-mono">v{item.version}</Badge>
                        {STATUS_BADGE[state.status] && <Badge variant={state.status === "update" ? "default" : "secondary"}>{STATUS_BADGE[state.status]}</Badge>}
                        {state.status === "update" && <span className="text-xs text-muted-foreground">you have v{item.installedVersion}</span>}
                    </div>
                    {repoOf(item) && <p className="font-mono text-xs text-muted-foreground">{repoOf(item)}</p>}
                    {item.description && <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{item.description}</p>}
                    <ul className="space-y-0.5 text-xs text-muted-foreground">{summarize(item).map((line) => <li key={line}>{line}</li>)}</ul>
                </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
                {state.actions.map((action) => (
                    <Button key={action} size="sm" variant={action === "install" || action === "update" ? "default" : action === "uninstall" ? "outline" : "ghost"} disabled={busy} onClick={() => onAction(item, action)}>
                        {action === "install" ? <IconDownload /> : action === "update" ? <IconRefresh /> : null}{ACTION_LABEL[action]}
                    </Button>
                ))}
            </div>
        </div>
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

/** Review step for a plugin that comes from a GitHub repository: what it declares, its sha256, the stronger trust warning and the typed id. */
export function RepoConfirmBody({ preview, mode, typed, onTyped }: { preview: PluginRepoPreview; mode: "install" | "update"; typed: string; onTyped: (v: string) => void }) {
    return (
        <div className="space-y-4" data-slot="plugin-repo-confirm" data-mode={mode}>
            <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>{REPO_TRUST_WARNING}</AlertDescription></Alert>
            <div className="space-y-1">
                <p className="text-sm font-medium">{preview.name} <span className="font-mono text-xs text-muted-foreground">{preview.id}</span></p>
                {preview.description && <p className="text-xs text-muted-foreground">{preview.description}</p>}
                <ul className="space-y-0.5 break-all text-xs text-muted-foreground">{previewLines(preview).map((line) => <li key={line}>{line}</li>)}</ul>
                {mode === "update" && preview.installedVersion && <p className="text-xs text-muted-foreground">Installed: v{preview.installedVersion}. If the new version fails to start, Floq goes back to it.</p>}
            </div>
            {mode === "install" && (
                <div className="space-y-2">
                    <Label htmlFor="plugin-repo-confirm-id">Type <code className="rounded bg-muted px-1 py-0.5 font-mono">{preview.id}</code> to confirm</Label>
                    <Input id="plugin-repo-confirm-id" value={typed} onChange={(e) => onTyped(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
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
    const [repoUrl, setRepoUrl] = useState("");
    const [sources, setSources] = useState<Record<string, string>>({});
    const [repoPending, setRepoPending] = useState<{ url: string; preview: PluginRepoPreview; mode: "install" | "update" } | null>(null);
    const { all: plugins } = usePlugins();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<CatalogFilter>("all");
    const [category, setCategory] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const visible = useMemo(() => filterCatalog(items ?? [], query, filter, category), [items, query, filter, category]);
    const categories = useMemo(() => [...new Set((items ?? []).map(categoryOf))].sort(), [items]);
    const selected = visible.find((i) => i.id === selectedId) ?? visible[0] ?? null;
    const countOf = (f: CatalogFilter) => (items ?? []).filter((i) => matchesFilter(i, f)).length;

    const load = useCallback(async () => {
        if (!client) return;
        setError("");
        try { setItems(await client.pluginCatalog()); } catch (e) { setItems(null); setError(errorMessage(e)); }
        try { setSources(await client.pluginSources()); } catch { setSources({}); }
    }, [client]);
    useEffect(() => { if (open) { setItems(null); void load(); } }, [open, load]);

    function ask(item: PluginCatalogItem, action: CatalogAction) { setTyped(""); setPending({ item, action }); }

    /** Fetches and verifies the repository's newest release, then opens the review step. Nothing is installed yet. */
    async function review(url: string, mode: "install" | "update") {
        if (!client) return;
        setBusy(true);
        try { setTyped(""); setRepoPending({ url, preview: await client.inspectPluginRepo(url), mode }); }
        catch (e) { toast.error(mode === "install" ? "Could not review that repository" : "Could not check for the update", { description: errorMessage(e) }); }
        finally { setBusy(false); }
    }

    async function runRepo() {
        if (!client || !repoPending) return;
        const { url, preview, mode } = repoPending;
        setBusy(true);
        try {
            if (mode === "install") await client.installPluginFromRepo(url, preview.sha256, typed.trim());
            else await client.updatePlugin(preview.id, preview.sha256);
            toast.success(mode === "install" ? `${preview.name} installed` : `${preview.name} updated to v${preview.version}`, mode === "install" ? { description: "It is off until you turn it on in the list." } : undefined);
            setRepoPending(null); setRepoUrl("");
            await Promise.all([refresh(), load()]);
        } catch (e) {
            toast.error(`Could not ${mode} ${preview.name}`, { description: errorMessage(e) });
        } finally { setBusy(false); }
    }

    const repoItems = plugins.filter((p) => p.source === "installed" && sources[p.id]);

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
            <AppDialog open={open && !pending && !repoPending} onOpenChange={onOpenChange} icon={<IconDownload />} title="Browse plugins" description="Plugins published in floq-plugins. Only administrators can install them." size="lg" className="sm:max-w-4xl"
                footer={<Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>}>
                {error ? (
                    <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>
                ) : items === null ? <p role="status" className="text-sm text-muted-foreground">Loading the catalog…</p>
                : items.length === 0 ? <p className="text-sm text-muted-foreground">The catalog is empty.</p>
                : (
                    <div data-slot="plugin-explorer" className="grid gap-4 md:grid-cols-[11rem_minmax(0,1fr)]">
                        <nav aria-label="Filter plugins" className="flex gap-4 overflow-x-auto md:flex-col md:gap-5 md:overflow-visible">
                            <ul className="flex gap-1 md:flex-col">
                                {(Object.keys(FILTER_LABEL) as CatalogFilter[]).map((f) => (
                                    <li key={f}><button type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", filter === f && "bg-muted font-medium")}>{FILTER_LABEL[f]}<span className="text-xs text-muted-foreground">{countOf(f)}</span></button></li>
                                ))}
                            </ul>
                            {categories.length > 1 && (
                                <div className="md:space-y-1">
                                    <p className="hidden px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block">Categories</p>
                                    <ul className="flex gap-1 md:flex-col">
                                        {categories.map((c) => (
                                            <li key={c}><button type="button" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)} className={cn("w-full whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", category === c && "bg-muted font-medium")}>{c}</button></li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </nav>
                        <div className="min-w-0 space-y-3">
                            <div className="relative">
                                <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                <Input type="search" aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" className="pl-8" />
                            </div>
                            {visible.length === 0 ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">No plugins match.</p> : (
                                <ul aria-label="Plugin catalog" className="grid max-h-[34dvh] grid-cols-1 gap-2 overflow-y-auto p-0.5 sm:grid-cols-2 lg:grid-cols-3">
                                    {visible.map((item) => <CatalogCard key={item.id} item={item} selected={selected?.id === item.id} onSelect={setSelectedId} />)}
                                </ul>
                            )}
                            {selected && <section aria-label={`${selected.name} details`} className="rounded-xl border border-border p-4"><CatalogRow item={selected} busy={busy} onAction={ask} /></section>}
                        </div>
                    </div>
                )}
                <section aria-label="Install from GitHub" className="mt-4 space-y-3" data-slot="plugin-repo-install">
                    <div className="space-y-1">
                        <Label htmlFor="plugin-repo-url">Install from a GitHub repository</Label>
                        <p className="text-xs text-muted-foreground">Any owner. Floq reads the repository's newest release and shows you what it contains before anything is installed. Updates are manual.</p>
                    </div>
                    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (repoUrl.trim()) void review(repoUrl.trim(), "install"); }}>
                        <Input id="plugin-repo-url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" autoComplete="off" spellCheck={false} className="font-mono" />
                        <Button type="submit" variant="outline" disabled={busy || !repoUrl.trim()}>Review</Button>
                    </form>
                    {repoItems.length > 0 && (
                        <ul aria-label="Installed from GitHub" className="divide-y divide-border rounded-xl border border-border">
                            {repoItems.map((p) => (
                                <li key={p.id} data-plugin-repo={p.id} className="flex items-center justify-between gap-2 p-3">
                                    <div className="min-w-0"><span className="text-sm font-medium">{p.name}</span> <Badge variant="outline" className="font-mono">v{p.version}</Badge><p className="truncate font-mono text-xs text-muted-foreground">{sources[p.id]}</p></div>
                                    <div className="flex shrink-0 gap-2">
                                        <Button size="sm" variant="default" disabled={busy} onClick={() => void review(`https://github.com/${sources[p.id]}`, "update")}><IconRefresh />Check for update</Button>
                                        <Button size="sm" variant="outline" disabled={busy} onClick={() => ask({ id: p.id, name: p.name, version: p.version, apiVersion: 1, description: p.description, scope: p.scope, secrets: [], network: [], contributes: [], builtin: false, installedVersion: p.version, updateAvailable: false }, "uninstall")}>Uninstall</Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </AppDialog>
            <AppDialog open={!!repoPending} onOpenChange={(o) => { if (!busy && !o) setRepoPending(null); }} icon={<IconAlertTriangle />} size="md"
                title={repoPending ? `${repoPending.mode === "install" ? "Install" : "Update"} ${repoPending.preview.name}?` : ""}
                footer={<><Button variant="outline" disabled={busy} onClick={() => setRepoPending(null)}>Cancel</Button><Button disabled={busy || !repoPending || (repoPending.mode === "install" ? !confirmMatches(typed, repoPending.preview.id) : (repoPending.preview.installedVersion === repoPending.preview.version))} onClick={() => void runRepo()}>{repoPending?.mode === "update" ? "Update" : "Install"}</Button></>}>
                {repoPending && <RepoConfirmBody preview={repoPending.preview} mode={repoPending.mode} typed={typed} onTyped={setTyped} />}
            </AppDialog>
            <AppDialog open={!!pending} onOpenChange={(o) => { if (!busy && !o) setPending(null); }} icon={<IconAlertTriangle />} size="md"
                title={pending ? `${ACTION_LABEL[pending.action]} ${pending.item.name}?` : ""}
                footer={<><Button variant="outline" disabled={busy} onClick={() => setPending(null)}>Cancel</Button><Button variant={pending?.action === "purge" || pending?.action === "uninstall" ? "destructive" : "default"} disabled={busy || !ok} onClick={() => void run()}>{busy ? "Working…" : pending ? ACTION_LABEL[pending.action] : ""}</Button></>}>
                {pending && <ConfirmBody item={pending.item} action={pending.action} typed={typed} onTyped={setTyped} />}
            </AppDialog>
        </>
    );
}
