import { useCallback, useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { ClaudeAccount } from "@/lib/runtime/types";
import ClaudeOAuthDialog from "./claude-oauth-dialog";
import { SettingRow, SettingsGroup } from "./ui";

/**
 * Every connected Claude login, in priority order: agents use the first one, and when it hits a usage limit the
 * "Another Claude account" fallback step moves down the list. Reorder with the arrows, remove any account with the trash icon.
 */
export function ClaudeAccountsGroup({ onChanged }: { onChanged?: () => void }) {
    const client = useClient();
    const [accounts, setAccounts] = useState<ClaudeAccount[] | null>(null);
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ slot: string; label: string } | null>(null);

    const reload = useCallback(async () => {
        try { setAccounts(await client.claudeAccounts()); } catch { setAccounts([]); }
    }, [client]);
    useEffect(() => { void reload(); }, [reload]);

    async function run(key: string, task: () => Promise<ClaudeAccount[]>, failure: string) {
        setBusy(key);
        try { setAccounts(await task()); onChanged?.(); } catch (e) { toast.error(failure, { description: errorMessage(e) }); } finally { setBusy(null); }
    }

    function move(index: number, by: -1 | 1) {
        const list = [...(accounts ?? [])];
        const target = index + by;
        if (target < 0 || target >= list.length) return;
        [list[index], list[target]] = [list[target]!, list[index]!];
        setAccounts(list); // optimistic: the arrows feel instant, the server answer replaces it
        void run("order", () => client.reorderClaudeAccounts(list.map((a) => a.slot)), "Could not change the order");
    }

    const [removing, setRemoving] = useState<ClaudeAccount | null>(null);

    const list = accounts ?? [];
    return (
        <SettingsGroup title="Claude accounts">
            {list.length > 1 && (
                <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">Agents use the first account. When it hits a usage limit, the next one takes over.</p>
            )}
            <div className="flex flex-col divide-y divide-border" role="list" aria-label="Claude accounts in priority order">
                {list.map((account, index) => (
                    <div key={account.slot} role="listitem" className="flex items-center gap-3 p-4">
                        {list.length > 1 && (
                            <div className="flex flex-col">
                                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${account.label} up`} disabled={busy !== null || index === 0} onClick={() => move(index, -1)}><IconArrowUp aria-hidden="true" /></Button>
                                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${account.label} down`} disabled={busy !== null || index === list.length - 1} onClick={() => move(index, 1)}><IconArrowDown aria-hidden="true" /></Button>
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            {editing?.slot === account.slot ? (
                                <Input
                                    aria-label="Account name"
                                    autoFocus
                                    maxLength={40}
                                    value={editing.label}
                                    className="h-7 w-48"
                                    onChange={(e) => setEditing({ slot: account.slot, label: e.target.value })}
                                    onBlur={() => { const label = editing.label.trim(); setEditing(null); if (label && label !== account.label) void run(account.slot, () => client.renameClaudeAccount(account.slot, label), "Could not rename"); }}
                                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(null); }}
                                />
                            ) : (
                                <span className="flex items-center gap-2 text-sm font-medium">
                                    {list.length > 1 && <span className="tabular-nums text-muted-foreground">{index + 1}.</span>}
                                    <button type="button" className="truncate rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70" title="Rename" onClick={() => setEditing({ slot: account.slot, label: account.label })}>{account.label}</button>
                                    {account.status === "disconnected" && <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-destructive">Sign in again</Badge>}
                                </span>
                            )}
                            <p className="text-xs leading-relaxed text-muted-foreground">{account.plan ? `Claude ${account.plan}` : "Claude"}</p>
                        </div>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${account.label}`} title="Remove" className="text-muted-foreground hover:text-destructive" disabled={busy !== null} onClick={() => setRemoving(account)}>
                            {busy === account.slot ? <Spinner /> : <IconTrash aria-hidden="true" />}
                        </Button>
                    </div>
                ))}
            </div>
            <SettingRow settingId="accounts-add-claude" label="Add another Claude account" description="Added at the end of the list. Signing in to an account that is already here renews its login.">
                <Button size="sm" onClick={() => setAdding(true)}>Add account</Button>
            </SettingRow>
            <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {list.length <= 1
                                ? "This is your only Claude account, so Claude will be signed out."
                                : list[0]?.slot === removing?.slot
                                    ? "Agents move to the next account in the list. You can sign in to this account again later."
                                    : "You can sign in to this account again later."}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => { const account = removing; setRemoving(null); if (account) void run(account.slot, () => client.removeClaudeAccount(account.slot), "Could not remove account"); }}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            {adding && (
                <ClaudeOAuthDialog open addAccount onOpenChange={(open) => !open && setAdding(false)} onConnected={() => { void reload(); onChanged?.(); }} onUnsupported={() => { setAdding(false); toast.error("Adding an account is not supported by this runtime"); }} />
            )}
        </SettingsGroup>
    );
}
