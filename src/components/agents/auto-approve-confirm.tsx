import { useEffect, useRef, useState } from "react";
import type { RuntimeClient } from "@/lib/runtime/client";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** What the user chose: keep auto-approve on, turn it off, or back out without starting the agent. */
type Choice = "keep" | "off" | "cancel";

type Pending = { resolve: (choice: Choice) => void };

let listener: ((pending: Pending) => void) | null = null;

/**
 * Before the first agent session of a user: one-time confirmation that auto-approve (the default) lets agents run
 * commands in the container without asking. The answer is stored server-side per user (settings.autoApproveAcknowledged),
 * so it is asked once across devices. Resolves true when the session may start.
 * Never blocks on failure: an older runtime or an unreachable settings call lets the session start as before.
 */
export async function confirmAutoApprove(client: RuntimeClient, provider: string): Promise<boolean> {
    if (provider !== "claude" && provider !== "codex") return true;
    let settings;
    try {
        settings = await client.settings();
    } catch {
        return true;
    }
    if (settings.autoApproveAcknowledged !== false) return true; // acknowledged, or an older runtime without the field
    const autoApprove = provider === "claude" ? settings.claudeAutoApprove : settings.codexAutoApprove;
    if (!autoApprove) {
        // Already off for this provider: nothing to warn about, remember that so the question never appears.
        void client.updateSettings({ autoApproveAcknowledged: true }).catch(() => undefined);
        return true;
    }
    if (!listener) return true; // no host mounted
    const choice = await new Promise<Choice>((resolve) => listener?.({ resolve }));
    if (choice === "cancel") return false;
    try {
        await client.updateSettings(
            choice === "off"
                ? { claudeAutoApprove: false, codexAutoApprove: false, autoApproveAcknowledged: true }
                : { autoApproveAcknowledged: true },
        );
    } catch {
        // Could not save: the dialog will simply appear again next time.
    }
    return true;
}

/** Mount once at the app root, next to the other dialog hosts. */
export function AutoApproveConfirmHost() {
    const [pending, setPending] = useState<Pending | null>(null);
    const current = useRef<Pending | null>(null);

    useEffect(() => {
        listener = (next) => {
            // A request arriving while another is pending cancels the old one, so its caller never hangs.
            current.current?.resolve("cancel");
            current.current = next;
            setPending(next);
        };
        return () => {
            listener = null;
            current.current?.resolve("cancel");
            current.current = null;
        };
    }, []);

    function answer(choice: Choice) {
        current.current?.resolve(choice);
        current.current = null;
        setPending(null);
    }

    return (
        <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) answer("cancel"); }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Agents run commands without asking</AlertDialogTitle>
                    <AlertDialogDescription>
                        Auto-approve is on by default. Claude Code and Codex will run shell commands and edit files in your runtime container
                        without a confirmation prompt. The container is not a hardened boundary, so run the runtime on a dedicated host.
                        You can change this any time in Settings &gt; Agents.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <Button variant="ghost" onClick={() => answer("cancel")}>Cancel</Button>
                    <Button variant="outline" onClick={() => answer("off")}>Turn auto-approve off</Button>
                    <Button onClick={() => answer("keep")}>Keep it on</Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
