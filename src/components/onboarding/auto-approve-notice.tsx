import { useEffect, useState } from "react";
import { useRuntime } from "@/lib/runtime/store";
import { requestSettingFocus } from "@/lib/settings-index";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Onboarding notice, shown once per user right after sign-in: agent auto-approve is on by default and each person can
 * turn it off. "Seen" is the server-side settings.autoApproveAcknowledged flag (per user, across devices), the same flag
 * the first-session confirmation in agents/auto-approve-confirm.tsx uses, so answering either one silences both.
 * Never blocks on failure: an older runtime (no flag) or an unreachable settings call shows nothing.
 */
export function AutoApproveNotice() {
    const { client, user, openSettings } = useRuntime();
    const [open, setOpen] = useState(false);
    const userId = user?.id;

    useEffect(() => {
        if (!userId || !client) return;
        let cancelled = false;
        void client.settings().then((s) => {
            if (cancelled || s.autoApproveAcknowledged !== false) return;
            if (!s.claudeAutoApprove && !s.codexAutoApprove) {
                // Already off everywhere: nothing to tell them, and the question never needs to appear.
                void client.updateSettings({ autoApproveAcknowledged: true }).catch(() => undefined);
                return;
            }
            setOpen(true);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [client, userId]);

    function dismiss(thenOpenSettings: boolean) {
        setOpen(false);
        void client?.updateSettings({ autoApproveAcknowledged: true }).catch(() => undefined); // failure: it simply appears again next time
        if (thenOpenSettings) {
            requestSettingFocus("agents-claude-auto-approve");
            openSettings("agents");
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(false); }}>
            <DialogContent data-testid="auto-approve-notice">
                <DialogHeader>
                    <DialogTitle>Auto-approve is on by default</DialogTitle>
                    <DialogDescription>
                        Claude Code and Codex run commands and edit files in your runtime container without asking first.
                        Each person can turn this off for themselves in Settings &gt; Agents, any time.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => dismiss(true)}>Turn it off in Settings</Button>
                    <Button autoFocus onClick={() => dismiss(false)}>Got it</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
