import { useEffect, useId, useState, type ReactNode } from "react";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/runtime/store";

/** Destructive confirmation. With `requireText` the action stays disabled until that exact text is typed. */
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    actionLabel,
    requireText,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: ReactNode;
    actionLabel: string;
    requireText?: string;
    onConfirm: () => Promise<void>;
}) {
    const inputId = useId();
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { if (!open) { setTyped(""); setError(null); setBusy(false); } }, [open]);

    const matches = requireText === undefined || typed.trim() === requireText;

    async function run() {
        setBusy(true);
        setError(null);
        try {
            await onConfirm();
            onOpenChange(false);
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription>
                </AlertDialogHeader>
                {requireText !== undefined && (
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={inputId} className="text-sm">Type <span className="font-mono font-semibold">{requireText}</span> to confirm</label>
                        <Input id={inputId} value={typed} autoFocus spellCheck={false} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && matches && !busy) { e.preventDefault(); void run(); } }} />
                    </div>
                )}
                <div aria-live="assertive">{error && <ErrorBanner>{error}</ErrorBanner>}</div>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button variant="destructive" loading={busy} disabled={!matches} onClick={() => void run()}>{actionLabel}</Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
