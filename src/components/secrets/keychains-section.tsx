import { useCallback, useEffect, useState } from "react";
import { IconExternalLink, IconLock, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { deleteKeychainRequest, fetchAllKeychains, requestKeychainFocus, type KeychainSummary } from "@/components/canvas/canvas-data";
import KeychainDialog from "@/components/canvas/keychain-dialog";
import { COLORS } from "@/components/canvas/canvas-notes";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import { SettingsGroup } from "../settings/ui";

/** Every keychain across projects: wallets of secrets that are linked to agents on a project canvas. */
export default function KeychainsSection() {
    const client = useClient();
    const { openCanvas, projects } = useRuntime();
    const [items, setItems] = useState<KeychainSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [managing, setManaging] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<KeychainSummary | null>(null);

    const load = useCallback(async () => {
        try { setItems(await fetchAllKeychains(client)); setError(null); }
        catch (e) { setError(errorMessage(e)); setItems((current) => current ?? []); }
    }, [client]);
    useEffect(() => { void load(); }, [load]);

    const projectName = (item: KeychainSummary) => item.projectName ?? projects.find((project) => project.id === item.projectId)?.name ?? "Scratch";
    const current = items?.find((item) => item.id === managing);

    return (
        <section className="flex flex-col gap-2" aria-labelledby="keychains-heading">
            <div>
                <h2 id="keychains-heading" className="text-sm font-semibold">Keychains</h2>
                <p className="text-xs text-muted-foreground">Wallets of secrets you create on a project canvas and link to agents. Encrypted at rest; values are never shown.</p>
            </div>
            <SettingsGroup className="overflow-hidden">
                {error && <p role="alert" className="p-3 text-sm text-destructive">Could not load keychains: {error}</p>}
                {items && items.length === 0 && !error && (
                    <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
                        <IconLock size={22} className="text-amber-500" />
                        <p>No keychains yet. Add one on a project canvas, put secrets in it, then draw a wire from it to the agents that should receive them as environment variables.</p>
                        <Button type="button" variant="outline" size="sm" onClick={() => { const first = projects[0]; if (first) openCanvas(first.id); }} disabled={projects.length === 0}>Open canvas to create one</Button>
                    </div>
                )}
                {items && items.length > 0 && (
                    <ul className="divide-y">
                        {items.map((item) => (
                            <li key={item.id} className="flex flex-wrap items-center gap-3 p-3">
                                <span className={cn("size-3 shrink-0 rounded-full", COLORS[item.color]?.dot ?? "bg-amber-400")} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2"><span className="truncate text-sm font-medium">{item.name}</span><span className="truncate text-xs text-muted-foreground">{projectName(item)}</span></div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {item.secretNames.slice(0, 8).map((name) => <span key={name} className="rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">{name}</span>)}
                                        {item.secretNames.length > 8 && <span className="text-[10px] text-muted-foreground">+{item.secretNames.length - 8}</span>}
                                        {item.secretNames.length === 0 && <span className="text-[11px] text-muted-foreground">No secrets</span>}
                                    </div>
                                </div>
                                <span className="text-xs text-muted-foreground tabular-nums">{item.secretNames.length} secret{item.secretNames.length === 1 ? "" : "s"} · {item.linkedCount ?? item.linkedSessionIds.length} agent{(item.linkedCount ?? item.linkedSessionIds.length) === 1 ? "" : "s"}</span>
                                <div className="flex items-center gap-1">
                                    <Button type="button" size="sm" variant="outline" onClick={() => setManaging(item.id)}>Manage secrets</Button>
                                    <Button type="button" size="sm" variant="ghost" disabled={!item.projectId} onClick={() => { if (item.projectId) { requestKeychainFocus(item.id); openCanvas(item.projectId); } }}><IconExternalLink size={14} />Open on canvas</Button>
                                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${item.name}`} onClick={() => setDeleting(item)}><IconTrash size={14} /></Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </SettingsGroup>
            {current && client && <KeychainDialog key={current.id} keychain={current} client={client} onClose={() => setManaging(null)} onChanged={load} />}
            <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete keychain {deleting?.name}?</AlertDialogTitle>
                        <AlertDialogDescription>This permanently destroys its secrets and unlinks it from every agent.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => {
                            const target = deleting;
                            setDeleting(null);
                            if (target) void deleteKeychainRequest(client, target.id).then(load, (e) => toast.error("Could not delete the keychain", { description: errorMessage(e) }));
                        }}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}
