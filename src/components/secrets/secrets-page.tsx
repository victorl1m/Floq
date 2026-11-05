import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { IconPencil, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogMedia,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FloqReveal, Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { Exposure, SecretInfo } from "@/lib/runtime/types";
import { SettingsGroup } from "../settings/ui";
import KeychainsSection from "./keychains-section";

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export default function SecretsPage() {
    const client = useClient();
    const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [description, setDescription] = useState("");
    const [expose, setExpose] = useState<Exposure>("tool");
    const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);
    const nameInputRef = useRef<HTMLInputElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    const load = useCallback(async () => {
        setLoadError(null);
        try {
            setSecrets(await client.secrets());
        } catch (e) {
            setLoadError(errorMessage(e));
        }
    }, [client]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (formOpen) nameInputRef.current?.focus();
        else if (returnFocusRef.current) {
            const target = returnFocusRef.current;
            requestAnimationFrame(() => (target.isConnected ? target : addButtonRef.current)?.focus());
            returnFocusRef.current = null;
        }
    }, [formOpen, editingOriginalName]);

    const nameValid = NAME_PATTERN.test(name);
    const duplicate = secrets?.some((s) => s.name === name && s.name !== editingOriginalName) ?? false;

    function edit(secret: SecretInfo, event: MouseEvent<HTMLButtonElement>) {
        returnFocusRef.current = event.currentTarget;
        setFormOpen(true);
        setEditingOriginalName(secret.name);
        setName(secret.name);
        setDescription(secret.description);
        setExpose(secret.expose);
        setValue("");
        setSaveError(null);
    }

    function resetForm(close = true) {
        setEditingOriginalName(null);
        setName("");
        setValue("");
        setDescription("");
        setExpose("tool");
        setSaveError(null);
        if (close) setFormOpen(false);
    }

    function beginAdd(event: MouseEvent<HTMLButtonElement>) {
        returnFocusRef.current = event.currentTarget;
        resetForm(false);
        setFormOpen(true);
    }

    function cancelForm() {
        resetForm();
    }

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (!nameValid || duplicate || (editingOriginalName === null && !value)) return;
        setBusy(true);
        setSaveError(null);
        try {
            if (editingOriginalName !== null) {
                const input: { name: string; description: string; expose: Exposure; value?: string } = {
                    name, description: description.trim(), expose,
                };
                if (value !== "") input.value = value;
                setSecrets(await client.patchSecret(editingOriginalName, input)); window.dispatchEvent(new Event("floq:vault-changed"));
                toast.success("Secret changes saved", { description: "Agents that use this secret get the new value in new sessions." });
            } else {
                setSecrets(await client.putSecret(name, { value, description: description.trim(), expose })); window.dispatchEvent(new Event("floq:vault-changed"));
                toast.success("Secret added", { description: "It is stored in your vault and never shown again in full." });
            }
            resetForm();
        } catch (e) {
            setSaveError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    }

    async function confirmDelete() {
        const target = deleting;
        setDeleting(null);
        if (!target) return;
        try {
            setSecrets(await client.deleteSecret(target)); window.dispatchEvent(new Event("floq:vault-changed"));
            toast.success("Secret deleted", { description: "It was removed from your vault." });
        } catch (e) {
            toast.error("Could not delete secret", { description: errorMessage(e) });
        }
    }

    return (
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 p-5 md:gap-6 md:p-8">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0"><h1 className="page-heading font-semibold tracking-tight">Secrets</h1><p className="mt-1 text-sm text-muted-foreground">Manage values agents can use without exposing them in terminal output.</p></div>
                <Button ref={addButtonRef} shimmer onClick={beginAdd} disabled={busy || formOpen}><IconPlus />Add secret</Button>
            </header>
            <SettingsGroup className="overflow-hidden">
            <FloqReveal className="block" loading={secrets === null && !loadError} revealOnMount={false}>
            {secrets === null && !loadError ? (
                <div role="status" aria-label="Loading secrets" className="divide-y divide-border">
                    {[0, 1, 2].map((row) => <div key={row} className="flex items-center gap-4 px-4 py-3">
                        <Skeleton className="h-3 w-28" /><Skeleton className="h-3 min-w-0 flex-1" /><Skeleton className="h-6 w-14" /><Skeleton className="h-3 w-24" />
                    </div>)}
                    <span className="sr-only">Loading secrets…</span>
                </div>
            ) : loadError ? (
                <Empty className="min-h-32 flex-none border-0 bg-transparent p-5">
                    <EmptyHeader><EmptyTitle>Could not load secrets</EmptyTitle><EmptyDescription>{loadError}</EmptyDescription></EmptyHeader>
                    <EmptyContent><Button type="button" variant="outline" size="sm" onClick={() => void load()}><IconRefresh />Try again</Button></EmptyContent>
                </Empty>
            ) : secrets?.length ? (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead>Exposure</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead className="w-20">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {secrets.map((secret) => (
                            <TableRow key={secret.name}>
                                <TableCell className="font-mono text-xs">{secret.name}</TableCell>
                                <TableCell className="max-w-40 truncate text-muted-foreground">{secret.description}</TableCell>
                                <TableCell>
                                    <Badge variant="secondary">{secret.expose}</Badge>
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {secret.lastUsedAt ? new Date(secret.lastUsedAt).toLocaleString() : "never"}
                                </TableCell>
                                <TableCell>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label={"Edit " + secret.name}
                                        disabled={busy || formOpen}
                                        onClick={(event) => edit(secret, event)}
                                    >
                                        <IconPencil />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label={"Delete " + secret.name}
                                        disabled={busy}
                                        onClick={() => setDeleting(secret.name)}
                                    >
                                        <IconTrash />
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : (
                <Empty className="min-h-40 flex-none border-0 bg-transparent p-5">
                    <EmptyHeader><EmptyTitle>No secrets stored yet</EmptyTitle><EmptyDescription>Add a secret when an agent needs a credential.</EmptyDescription></EmptyHeader>
                    <EmptyContent><Button type="button" size="sm" onClick={beginAdd}><IconPlus />Add secret</Button></EmptyContent>
                </Empty>
            )}
            </FloqReveal>
            </SettingsGroup>

            {formOpen && <SettingsGroup>
            <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 p-4">
                <p className="text-sm font-medium">{editingOriginalName !== null ? `Edit ${editingOriginalName}` : "Add a secret"}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="secret-name">Name</Label>
                        <Input
                            id="secret-name"
                            ref={nameInputRef}
                            className="font-mono"
                            placeholder="MY_API_KEY"
                            value={name}
                            aria-invalid={(name !== "" && !nameValid) || duplicate}
                            aria-describedby={(name !== "" && !nameValid) || duplicate ? "secret-name-error" : undefined}
                            onChange={(e) => { setName(e.target.value.toUpperCase()); setSaveError(null); }}
                        />
                        {(name !== "" && !nameValid || duplicate) && (
                            <p id="secret-name-error" className="text-xs text-destructive">
                                {duplicate ? "A secret with this name already exists." : "Use A-Z, 0-9 and _, starting with a letter (max 64)."}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="secret-value">Value</Label>
                        <Input
                            id="secret-value"
                            type="password"
                            autoComplete="off"
                            placeholder={editingOriginalName !== null ? "Enter a new value" : ""}
                            aria-describedby={editingOriginalName !== null ? "secret-value-help" : undefined}
                            value={value}
                            onChange={(e) => { setValue(e.target.value); setSaveError(null); }}
                        />
                        {editingOriginalName !== null && <p id="secret-value-help" className="text-xs text-muted-foreground">Leave blank to keep the current value.</p>}
                    </div>
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="secret-description">Description</Label>
                    <Input
                        id="secret-description"
                        maxLength={300}
                        value={description}
                        onChange={(e) => { setDescription(e.target.value); setSaveError(null); }}
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="secret-exposure">Exposure</Label>
                    <Select value={expose} onValueChange={(v) => { setExpose(v as Exposure); setSaveError(null); }}>
                        <SelectTrigger id="secret-exposure" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="tool">tool</SelectItem>
                            <SelectItem value="env">env</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {expose === "tool"
                            ? "tool: only available through `floq-vault run`; the agent never sees the value."
                            : "env: injected as an environment variable into every terminal."}
                    </p>
                </div>
                {saveError && <p role="alert" className="text-sm text-destructive">Could not save secret: {saveError}</p>}
                <div>
                    <div className="flex flex-wrap gap-2">
                    <Button type="submit" shimmer disabled={busy || !nameValid || duplicate || (editingOriginalName === null && !value)}>
                        {busy ? "Saving…" : editingOriginalName !== null ? "Save changes" : "Add secret"}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy} onClick={cancelForm}>Cancel</Button>
                    </div>
                </div>
            </form>
            </SettingsGroup>}

            <KeychainsSection />

            <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogMedia className="bg-destructive/10 text-destructive">
                            <IconTrash />
                        </AlertDialogMedia>
                        <AlertDialogTitle>Delete {deleting}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Agents will no longer be able to use this secret. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
