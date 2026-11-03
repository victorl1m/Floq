import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { UpdateItem, UpdatesStatus, UpdateTarget } from "@/lib/runtime/admin-types";
import { SettingRow, SettingsGroup } from "./ui";
import { useIsAdmin } from "./use-admin";

const LABELS: Record<UpdateTarget, string> = { runtime: "Floq Runtime", claude: "Claude Code", codex: "Codex" };

/** Administrator-only: check for and apply updates to the runtime and the bundled agent CLIs. */
export default function UpdatesGroup() {
    const { client } = useRuntime();
    const isAdmin = useIsAdmin();
    const [status, setStatus] = useState<UpdatesStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [busy, setBusy] = useState<UpdateTarget | null>(null);
    const [confirm, setConfirm] = useState<UpdateItem | null>(null);

    const check = useCallback(
        async (refresh: boolean) => {
            if (!client) return;
            setChecking(true);
            try {
                setStatus(await client.checkUpdates(refresh));
            } catch (e) {
                toast.error("Could not check for updates", { description: errorMessage(e) });
            } finally {
                setChecking(false);
            }
        },
        [client],
    );

    useEffect(() => {
        if (isAdmin) void check(false);
    }, [isAdmin, check]);

    if (!isAdmin) return null;

    const live = status?.activeSessions ?? 0;

    async function apply(item: UpdateItem) {
        if (!client) return;
        setBusy(item.target);
        try {
            // The confirmation dialog already told the admin how many sessions the restart stops.
            const result = await client.applyUpdate(item.target, item.target === "runtime" && live > 0);
            toast.success(`${LABELS[item.target]} updated`, {
                description: result.restarting ? "The runtime is restarting; the app will reconnect shortly." : "New sessions will use the new version.",
            });
            if (!result.restarting) await check(true);
        } catch (e) {
            toast.error(`Could not update ${LABELS[item.target]}`, { description: errorMessage(e) });
        } finally {
            setBusy(null);
        }
    }

    return (
        <SettingsGroup title="Updates">
            <SettingRow
                label="Check for updates"
                description={status ? `Last checked ${new Date(status.checkedAt).toLocaleTimeString()}` : "Compares installed versions with the latest releases."}
            >
                <Button variant="outline" size="sm" disabled={checking || busy !== null} onClick={() => void check(true)}>
                    {checking && <Spinner />}
                    Check for updates
                </Button>
            </SettingRow>
            {status?.items.map((item) => (
                <SettingRow
                    key={item.target}
                    label={LABELS[item.target]}
                    description={
                        item.error ? (
                            <span className="text-destructive">{item.error}</span>
                        ) : (
                            <span>
                                Installed {item.current ?? "unknown"}
                                {item.latest ? ` / latest ${item.latest}` : ""}
                            </span>
                        )
                    }
                >
                    {item.updateAvailable ? <Badge>Update available</Badge> : item.latest && !item.error && <Badge variant="secondary">Up to date</Badge>}
                    {item.updateAvailable && (
                        <Button size="sm" disabled={busy !== null} onClick={() => setConfirm(item)}>
                            {busy === item.target && <Spinner />}
                            Update
                        </Button>
                    )}
                </SettingRow>
            ))}
            <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Update {confirm ? LABELS[confirm.target] : ""}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirm?.target === "runtime"
                                ? live > 0
                                    ? `${live} agent session(s) are running and will be stopped when the runtime restarts.`
                                    : "The runtime will restart."
                                : "The CLI is reinstalled globally. Running sessions keep the old version; new sessions use the new one."}
                            {confirm?.latest ? ` Target version: ${confirm.latest}.` : ""}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant={confirm?.target === "runtime" ? "destructive" : "default"}
                            onClick={() => {
                                const item = confirm;
                                setConfirm(null);
                                if (item) void apply(item);
                            }}
                        >
                            Update
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </SettingsGroup>
    );
}
