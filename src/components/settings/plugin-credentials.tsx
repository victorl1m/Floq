import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { IconTrash } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
    AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/runtime/store";
import type { PluginInfo, PluginSecretStatus } from "@/lib/runtime/types";

/** The slice of the runtime client the credentials UI uses (so tests can mock it). */
export interface CredentialsApi {
    getPluginSecrets(id: string): Promise<PluginSecretStatus[]>;
    setPluginSecret(id: string, name: string, value: string): Promise<void>;
    deletePluginSecret(id: string, name: string): Promise<void>;
}

/** Rows to show before (or without) the status call: presence from `GET /v1/plugins`, editing decided by scope. */
export function fallbackRows(plugin: PluginInfo, isAdmin: boolean): PluginSecretStatus[] {
    return plugin.secrets.map((s) => ({ name: s.name, description: s.description ?? "", required: s.required, present: s.present, updatedAt: null, scope: plugin.scope, editable: plugin.scope === "user" || isAdmin }));
}

/**
 * Sends one value and ALWAYS clears the draft once the response (or failure) is in: the value never outlives the request.
 * Returns an error message that names no value, or "" on success.
 */
export async function submitCredential(api: CredentialsApi, pluginId: string, name: string, value: string, clear: () => void): Promise<string> {
    try {
        await api.setPluginSecret(pluginId, name, value);
        return "";
    } catch (error) {
        return errorMessage(error);
    } finally {
        clear();
    }
}

function CredentialRow({ row, editing, draft, saving, error, onDraft, onEdit, onCancel, onSave, onRemove }: {
    row: PluginSecretStatus; editing: boolean; draft: string; saving: boolean; error: string;
    onDraft: (v: string) => void; onEdit: () => void; onCancel: () => void; onSave: () => void; onRemove: () => void;
}) {
    const id = `plugin-credential-${row.name}`;
    return (
        <li data-credential={row.name} data-present={row.present ? "true" : "false"} className="space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{row.name}</code>
                <Badge variant={row.present ? "secondary" : row.required ? "destructive" : "outline"}>{row.present ? "Present" : "Missing"}</Badge>
                <span className="text-muted-foreground">{row.required ? "Required" : "Optional"}</span>
                {row.editable && !editing && (
                    <span className="ml-auto flex items-center gap-1">
                        <Button variant="outline" size="xs" onClick={onEdit}>{row.present ? "Replace" : "Set"}</Button>
                        {row.present && <Button variant="ghost" size="xs" onClick={onRemove}>Remove</Button>}
                    </span>
                )}
            </div>
            {row.description && <p className="text-muted-foreground">{row.description}</p>}
            {editing && row.editable && (
                <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (draft) onSave(); }} noValidate className="space-y-2">
                    <Field data-invalid={error ? "true" : undefined}>
                        <FieldLabel htmlFor={id} className="sr-only">New value for {row.name}</FieldLabel>
                        <Input
                            id={id} type="password" autoComplete="off" spellCheck={false} value={draft} disabled={saving}
                            placeholder="Paste the value" aria-invalid={error ? true : undefined}
                            onChange={(e) => onDraft(e.target.value)}
                        />
                        {error && <FieldError role="alert">{error}</FieldError>}
                    </Field>
                    <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={saving || !draft}>{saving ? "Saving…" : "Save"}</Button>
                        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
                    </div>
                </form>
            )}
            {!editing && error && <p role="alert" className="text-destructive">{error}</p>}
        </li>
    );
}

/** Settings > Plugins > Configure > Credentials: write-only values; the app only ever learns present/missing. */
export function PluginCredentials({ plugin, isAdmin, api, onChanged, initialRows, initialEditing }: {
    plugin: PluginInfo; isAdmin: boolean; api: CredentialsApi | null; onChanged?: () => void;
    /** Test hooks: server render has no effects. */
    initialRows?: PluginSecretStatus[]; initialEditing?: string | null;
}) {
    const [rows, setRows] = useState<PluginSecretStatus[] | null>(initialRows ?? null);
    const [editing, setEditing] = useState<string | null>(initialEditing ?? null);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [removing, setRemoving] = useState<string | null>(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; setDraft(""); }; }, []);

    const load = useCallback(async () => {
        if (!api) return;
        try { const next = await api.getPluginSecrets(plugin.id); if (alive.current) setRows(next); } catch (e) { if (alive.current) setErrors((m) => ({ ...m, "": errorMessage(e) })); }
    }, [api, plugin.id]);
    useEffect(() => { if (!initialRows) void load(); }, [load, initialRows]);

    const shown = rows ?? fallbackRows(plugin, isAdmin);
    if (!shown.length) return null;
    const readOnlyInstall = plugin.scope === "install" && !shown.some((r) => r.editable);

    const setError = (name: string, message: string) => setErrors((m) => ({ ...m, [name]: message }));
    const stopEditing = () => { setDraft(""); setEditing(null); };

    async function save(name: string) {
        if (!api || !draft) return;
        setSaving(true); setError(name, "");
        const failure = await submitCredential(api, plugin.id, name, draft, () => setDraft(""));
        if (!alive.current) return;
        setSaving(false);
        if (failure) { setError(name, failure); return; }
        setEditing(null);
        await load(); onChanged?.();
    }

    async function remove(name: string) {
        setRemoving(null);
        if (!api) return;
        try { await api.deletePluginSecret(plugin.id, name); setError(name, ""); await load(); onChanged?.(); } catch (e) { setError(name, errorMessage(e)); }
    }

    return (
        <div className="space-y-2" data-slot="plugin-credentials">
            <div className="text-xs font-medium text-muted-foreground">Credentials</div>
            <ul className="space-y-3">
                {shown.map((row) => (
                    <CredentialRow
                        key={row.name} row={row} editing={editing === row.name} draft={editing === row.name ? draft : ""} saving={saving} error={errors[row.name] ?? ""}
                        onDraft={setDraft} onEdit={() => { setDraft(""); setError(row.name, ""); setEditing(row.name); }} onCancel={stopEditing}
                        onSave={() => void save(row.name)} onRemove={() => setRemoving(row.name)}
                    />
                ))}
            </ul>
            {errors[""] && <p role="alert" className="text-xs text-destructive">{errors[""]}</p>}
            {readOnlyInstall && <p className="text-xs text-muted-foreground" data-slot="plugin-credentials-readonly">Configured by an administrator.</p>}
            <p className="text-xs text-muted-foreground">Values are stored encrypted for this plugin only and are never shown again. Agents cannot read them.</p>
            <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogMedia className="bg-destructive/10 text-destructive"><IconTrash /></AlertDialogMedia>
                        <AlertDialogTitle>Remove {removing}?</AlertDialogTitle>
                        <AlertDialogDescription>{plugin.name} will stop working until a new value is set. This cannot be undone.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => { if (removing) void remove(removing); }}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/** One-time notice in Settings > Plugins; names only. */
export function MigrationNotice({ items, onDismiss }: { items: { pluginName: string; name: string }[]; onDismiss: () => void }) {
    if (!items.length) return null;
    return (
        <div role="status" data-slot="plugin-migration-notice" className="flex items-start justify-between gap-3 rounded-xl border border-border bg-muted/40 p-3 text-xs">
            <div className="min-w-0 space-y-1">
                <div className="font-medium">Credentials migrated from Secrets</div>
                <ul className="space-y-0.5 text-muted-foreground">
                    {items.map((i) => <li key={i.pluginName + i.name}><code className="font-mono text-foreground">{i.name}</code> → {i.pluginName}</li>)}
                </ul>
            </div>
            <Button variant="ghost" size="xs" onClick={onDismiss}>Dismiss</Button>
        </div>
    );
}

/** One-time notice on the Secrets page: it only renders text, it never reads plugin secrets. */
export function MovedSecretsNotice({ items, onDismiss }: { items: { pluginName: string; name: string; keptInVault: boolean }[]; onDismiss: () => void }) {
    if (!items.length) return null;
    return (
        <div role="status" data-slot="secrets-moved-notice" className="flex items-start justify-between gap-3 rounded-xl border border-border bg-muted/40 p-3 text-xs">
            <ul className="min-w-0 space-y-1">
                {items.map((i) => (
                    <li key={i.pluginName + i.name}>
                        <code className="font-mono">{i.name}</code> moved to Settings &gt; Plugins &gt; {i.pluginName}
                        {i.keptInVault && <span className="text-muted-foreground"> (kept here because another tool still uses it)</span>}
                    </li>
                ))}
            </ul>
            <Button variant="ghost" size="xs" onClick={onDismiss}>Dismiss</Button>
        </div>
    );
}
