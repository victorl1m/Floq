import { useCallback, useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconArrowLeft, IconBrandGithub, IconDownload, IconPlugConnected, IconRefresh, IconSearch } from "@tabler/icons-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/app-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { PluginCatalogItem, PluginRepoPreview } from "@/lib/runtime/types";
import { ACTION_LABEL, FILTER_LABEL, REPO_TRUST_WARNING, TRUST_WARNING, avatarUrl, categoryOf, confirmMatches, filterCatalog, matchesFilter, repoOf, type CatalogFilter, previewLines, rowState, summarize, type CatalogAction } from "@/plugins/install-ui";
import { resolvePluginIcon } from "@/plugins/icons";
import { usePlugins } from "@/plugins/host";
import { cn } from "cn";

const NAV_ITEM = "flex min-h-8 shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-full";

/** Centered message that fills its pane: loading failures, empty catalog, no search results. Keeps the pane the same size as a populated one. */
function PaneState({ icon, title, text, action, role, compact }: { icon?: React.ReactNode; title: string; text: string; action?: React.ReactNode; role?: "alert"; compact?: boolean }) {
    return (
        <div role={role ?? "status"} className={cn("flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center", compact ? "" : "h-full")}>
            {icon && <div className="text-muted-foreground [&_svg]:size-6">{icon}</div>}
            <p className="text-sm font-medium">{title}</p>
            <p className="max-w-xs break-words text-xs text-muted-foreground">{text}</p>
            {action}
        </div>
    );
}

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

/** One grid card of the explorer. A button, so Enter/Space select it. Fixed height so the grid never jumps. */
export function CatalogCard({ item, selected, enabled = false, onSelect }: { item: PluginCatalogItem; selected: boolean; enabled?: boolean; onSelect: (id: string) => void }) {
    const state = rowState(item);
    return (
        <li className="min-w-0">
            <button type="button" data-plugin-card={item.id} data-state={state.status} aria-pressed={selected} onClick={() => onSelect(item.id)}
                className={cn("flex h-[8.5rem] w-full min-w-0 flex-col gap-2 overflow-hidden rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected ? "border-primary ring-1 ring-primary" : "border-border")}>
                <div className="flex min-w-0 items-start gap-3">
                    <PluginMark item={item} className="size-10" />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">v{item.version}{repoOf(item) ? ` · ${repoOf(item)}` : ""}</p>
                    </div>
                </div>
                <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{item.description || "No description."}</p>
                <div className="mt-auto flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <Badge variant="outline" className="max-w-24 shrink truncate">{categoryOf(item)}</Badge>
                    {STATUS_BADGE[state.status] && <Badge variant={state.status === "update" ? "default" : "secondary"} className="shrink-0">{STATUS_BADGE[state.status]}</Badge>}
                    {enabled && <Badge variant="secondary" className="shrink-0">On</Badge>}
                </div>
            </button>
        </li>
    );
}

/** The detail pane of the selected plugin (kept as `CatalogRow`). Presentational: the dialog owns the actions. Actions sit in a footer that never scrolls away. */
export function CatalogRow({ item, busy, onAction }: { item: PluginCatalogItem; busy: boolean; onAction: (item: PluginCatalogItem, action: CatalogAction) => void }) {
    const state = rowState(item);
    return (
        <div data-plugin-catalog={item.id} data-state={state.status} className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <div className="flex min-w-0 gap-3">
                    <PluginMark item={item} className="size-12" />
                    <div className="min-w-0 space-y-1">
                        <h3 className="break-words text-base font-semibold leading-tight">{item.name}</h3>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="font-mono">v{item.version}</Badge>
                            {STATUS_BADGE[state.status] && <Badge variant={state.status === "update" ? "default" : "secondary"}>{STATUS_BADGE[state.status]}</Badge>}
                        </div>
                        {state.status === "update" && <p className="text-xs text-muted-foreground">you have v{item.installedVersion}</p>}
                    </div>
                </div>
                {repoOf(item) && <p className="break-all font-mono text-xs text-muted-foreground">{repoOf(item)}</p>}
                {item.description && <p className="text-sm leading-relaxed text-muted-foreground">{item.description}</p>}
                <ul className="space-y-1 break-words text-xs text-muted-foreground">{summarize(item).map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
            {state.actions.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-3">
                    {state.actions.map((action) => (
                        <Button key={action} size="sm" variant={action === "install" || action === "update" ? "default" : action === "uninstall" ? "outline" : "ghost"} disabled={busy} onClick={() => onAction(item, action)}>
                            {action === "install" ? <IconDownload /> : action === "update" ? <IconRefresh /> : null}{ACTION_LABEL[action]}
                        </Button>
                    ))}
                </div>
            )}
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
    // "github" swaps the explorer for the install-from-repository form; detailOpen is the narrow-width list/detail switch.
    const [view, setView] = useState<"catalog" | "github">("catalog");
    const [detailOpen, setDetailOpen] = useState(false);
    const visible = useMemo(() => filterCatalog(items ?? [], query, filter, category), [items, query, filter, category]);
    const categories = useMemo(() => [...new Set((items ?? []).map(categoryOf))].sort(), [items]);
    const selected = visible.find((i) => i.id === selectedId) ?? visible[0] ?? null;
    const enabledIds = useMemo(() => new Set(plugins.filter((p) => p.enabled).map((p) => p.id)), [plugins]);
    const countOf = (f: CatalogFilter) => (items ?? []).filter((i) => matchesFilter(i, f)).length;

    const load = useCallback(async () => {
        if (!client) return;
        setError("");
        try { setItems(await client.pluginCatalog()); } catch (e) { setItems(null); setError(errorMessage(e)); }
        try { setSources(await client.pluginSources()); } catch { setSources({}); }
    }, [client]);
    useEffect(() => { if (open) { setItems(null); setView("catalog"); setDetailOpen(false); void load(); } }, [open, load]);

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
            <AppDialog open={open && !pending && !repoPending} onOpenChange={onOpenChange} icon={<IconDownload />} title="Browse plugins" description="Plugins published in floq-plugins. Only administrators can install them." className="h-[min(640px,calc(100dvh-4rem))] w-[min(960px,calc(100vw-2rem))] sm:max-w-none" bodyClassName="overflow-hidden p-0"
                footer={<Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>}>
                <div data-slot="plugin-explorer" className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[12rem_minmax(0,1fr)] md:grid-rows-1">
                    <nav aria-label="Filter plugins" className="flex min-w-0 gap-1 overflow-x-auto border-b border-border p-2 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-r md:p-3">
                        {(Object.keys(FILTER_LABEL) as CatalogFilter[]).map((f) => (
                            <button key={f} type="button" aria-pressed={view === "catalog" && filter === f} onClick={() => { setView("catalog"); setFilter(f); setDetailOpen(false); }} className={cn(NAV_ITEM, view === "catalog" && filter === f && "bg-muted font-medium")}>
                                <span className="truncate">{FILTER_LABEL[f]}</span><span className="text-xs text-muted-foreground">{countOf(f)}</span>
                            </button>
                        ))}
                        {categories.length > 1 && <p className="mt-3 hidden px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block">Categories</p>}
                        {categories.length > 1 && categories.map((c) => (
                            <button key={c} type="button" aria-pressed={view === "catalog" && category === c} onClick={() => { setView("catalog"); setCategory(category === c ? null : c); setDetailOpen(false); }} className={cn(NAV_ITEM, view === "catalog" && category === c && "bg-muted font-medium")}>
                                <span className="truncate">{c}</span>
                            </button>
                        ))}
                        <div className="mx-1 hidden border-t border-border md:my-2 md:block" />
                        <button type="button" aria-pressed={view === "github"} onClick={() => setView("github")} className={cn(NAV_ITEM, "md:mt-auto", view === "github" && "bg-muted font-medium")}>
                            <span className="flex min-w-0 items-center gap-2"><IconBrandGithub className="size-4 shrink-0" /><span className="truncate">From GitHub</span></span>
                        </button>
                    </nav>
                    {view === "github" ? (
                        <section aria-label="Install from GitHub" data-slot="plugin-repo-install" className="min-h-0 min-w-0 space-y-4 overflow-y-auto p-4">
                            <div className="space-y-1">
                                <Label htmlFor="plugin-repo-url">Install from a GitHub repository</Label>
                                <p className="text-xs text-muted-foreground">Any owner. Floq reads the repository's newest release and shows you what it contains before anything is installed. Updates are manual.</p>
                            </div>
                            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (repoUrl.trim()) void review(repoUrl.trim(), "install"); }}>
                                <Input id="plugin-repo-url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" autoComplete="off" spellCheck={false} className="min-w-0 font-mono" />
                                <Button type="submit" variant="outline" disabled={busy || !repoUrl.trim()}>Review</Button>
                            </form>
                            {repoItems.length > 0 && (
                                <ul aria-label="Installed from GitHub" className="divide-y divide-border rounded-xl border border-border">
                                    {repoItems.map((p) => (
                                        <li key={p.id} data-plugin-repo={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                                            <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-medium">{p.name}</span><Badge variant="outline" className="shrink-0 font-mono">v{p.version}</Badge></div><p className="truncate font-mono text-xs text-muted-foreground">{sources[p.id]}</p></div>
                                            <div className="flex shrink-0 gap-2">
                                                <Button size="sm" variant="default" disabled={busy} onClick={() => void review(`https://github.com/${sources[p.id]}`, "update")}><IconRefresh />Check for update</Button>
                                                <Button size="sm" variant="outline" disabled={busy} onClick={() => ask({ id: p.id, name: p.name, version: p.version, apiVersion: 1, description: p.description, scope: p.scope, secrets: [], network: [], contributes: [], builtin: false, installedVersion: p.version, updateAvailable: false }, "uninstall")}>Uninstall</Button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    ) : error ? (
                        <PaneState role="alert" icon={<IconAlertTriangle />} title="Could not load the catalog" text={error} action={<Button variant="outline" size="sm" onClick={() => { setItems(null); void load(); }}><IconRefresh />Retry</Button>} />
                    ) : items === null ? (
                        <div role="status" aria-label="Loading the catalog" className="grid min-h-0 content-start gap-2 overflow-hidden p-3 sm:grid-cols-2 lg:grid-cols-3">
                            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[8.5rem] rounded-xl" />)}
                        </div>
                    ) : items.length === 0 ? (
                        <PaneState icon={<IconPlugConnected />} title="The catalog is empty" text="Nothing is published in floq-plugins yet. You can still install from a GitHub repository." action={<Button variant="outline" size="sm" onClick={() => setView("github")}><IconBrandGithub />From GitHub</Button>} />
                    ) : (
                        <div className="grid min-h-0 min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem]">
                            <div className={cn("min-h-0 min-w-0 flex-col", detailOpen ? "hidden lg:flex" : "flex")}>
                                <div className="shrink-0 p-3 pb-2">
                                    <div className="relative">
                                        <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input type="search" aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" className="pl-8" />
                                    </div>
                                </div>
                                {visible.length === 0 ? (
                                    <PaneState compact title="No plugins match" text="Try another search, or pick a different filter." action={(query || filter !== "all" || category) ? <Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); setCategory(null); }}>Clear filters</Button> : undefined} />
                                ) : (
                                    <ul aria-label="Plugin catalog" className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2 overflow-y-auto p-3 pt-1 sm:grid-cols-2 xl:grid-cols-2">
                                        {visible.map((item) => <CatalogCard key={item.id} item={item} selected={selected?.id === item.id} enabled={enabledIds.has(item.id)} onSelect={(id) => { setSelectedId(id); setDetailOpen(true); }} />)}
                                    </ul>
                                )}
                            </div>
                            <section aria-label={selected ? `${selected.name} details` : "Plugin details"} className={cn("min-h-0 min-w-0 flex-col border-border lg:flex lg:border-l", detailOpen ? "flex" : "hidden")}>
                                <div className="shrink-0 border-b border-border p-2 lg:hidden">
                                    <Button variant="ghost" size="sm" onClick={() => setDetailOpen(false)}><IconArrowLeft />All plugins</Button>
                                </div>
                                <div className="min-h-0 flex-1">
                                    {selected ? <CatalogRow item={selected} busy={busy} onAction={ask} /> : <PaneState compact title="Select a plugin" text="Its permissions and actions show here." />}
                                </div>
                            </section>
                        </div>
                    )}
                </div>
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
