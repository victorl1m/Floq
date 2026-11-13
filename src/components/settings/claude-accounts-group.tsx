import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { ClaudeAccount } from "@/lib/runtime/types";
import ClaudeOAuthDialog from "./claude-oauth-dialog";
import { SettingRow, SettingsGroup } from "./ui";

/** Claude logins beyond the first: the reserve the usage-limit fallback can switch to. Shown only while Claude is connected. */
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

    async function run(slot: string, task: () => Promise<ClaudeAccount[]>, failure: string) {
        setBusy(slot);
        try { setAccounts(await task()); onChanged?.(); } catch (e) { toast.error(failure, { description: errorMessage(e) }); } finally { setBusy(null); }
    }

    return (
        <SettingsGroup title="Claude accounts">
            {(accounts ?? []).map((account) => (
                <SettingRow
                    key={account.slot}
                    label={
                        editing?.slot === account.slot ? (
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
                            <span className="flex items-center gap-2">
                                <button type="button" className="rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70" title="Rename" onClick={() => setEditing({ slot: account.slot, label: account.label })}>{account.label}</button>
                                {account.active && <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">Active</Badge>}
                                {account.status === "disconnected" && <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-destructive">Sign in again</Badge>}
                            </span>
                        )
                    }
                    description={account.plan ? `Claude ${account.plan}` : "Claude"}
                >
                    <div className="flex items-center gap-2">
                        {!account.active && account.status === "connected" && (
                            <Button variant="outline" size="sm" disabled={busy === account.slot} onClick={() => void run(account.slot, () => client.activateClaudeAccount(account.slot), "Could not switch account")}>
                                {busy === account.slot && <Spinner />}Make active
                            </Button>
                        )}
                        {account.slot !== "primary" && (
                            <Button variant="outline" size="sm" disabled={busy === account.slot} onClick={() => void run(account.slot, () => client.removeClaudeAccount(account.slot), "Could not remove account")}>Remove</Button>
                        )}
                    </div>
                </SettingRow>
            ))}
            <SettingRow settingId="accounts-add-claude" label="Add another Claude account" description="A second login stays in reserve. When an agent hits a usage limit, the “Another Claude account” fallback step can switch to it.">
                <Button size="sm" onClick={() => setAdding(true)}>Add account</Button>
            </SettingRow>
            {adding && (
                <ClaudeOAuthDialog open addAccount onOpenChange={(open) => !open && setAdding(false)} onConnected={() => { void reload(); onChanged?.(); }} onUnsupported={() => { setAdding(false); toast.error("Adding an account is not supported by this runtime"); }} />
            )}
        </SettingsGroup>
    );
}
