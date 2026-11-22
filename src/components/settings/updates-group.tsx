import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RuntimeError } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { UpdateItem, UpdatesStatus, UpdateTarget, WhatsappServerStatus } from "@/lib/runtime/admin-types";
import { SettingRow, SettingsGroup } from "./ui";
import { useIsAdmin } from "./use-admin";

const LABELS: Record<UpdateTarget, string> = { runtime: "Floq Runtime", claude: "Claude Code", codex: "Codex", whatsapp: "WhatsApp server" };

function formatResult(last: NonNullable<WhatsappServerStatus["autoUpdate"]["last"]>): string {
    const when = new Date(last.at).toLocaleString();
    const move = last.from && last.to ? ` ${last.from} to ${last.to}` : "";
    return `Last update (${when}):${move ? `${move}.` : ""} ${last.rolledBack ? "Rolled back. " : ""}${last.message}`.replace(/\s+/g, " ").trim();
}

/** Administrator-only: check for and apply updates to the runtime and the bundled agent CLIs. */
export default function UpdatesGroup() {
    const { client } = useRuntime();
    const isAdmin = useIsAdmin();
    const [status, setStatus] = useState<UpdatesStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [busy, setBusy] = useState<UpdateTarget | null>(null);
    const [confirm, setConfirm] = useState<UpdateItem | null>(null);
    const [forcing, setForcing] = useState<{ item: UpdateItem; message: string } | null>(null);
    const [wa, setWa] = useState<WhatsappServerStatus | null>(null);
    const [minutes, setMinutes] = useState("");
    const [savingAuto, setSavingAuto] = useState(false);

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

    const waItem = status?.items.find((i) => i.target === "whatsapp");
    const waManaged = !!waItem && waItem.managed !== false;
    useEffect(() => {
        if (!client || !isAdmin || !waManaged) return;
        let live = true;
        client.whatsappServer().then((s) => { if (live) { setWa(s); setMinutes(String(s.autoUpdate.quietMinutes)); } }, () => undefined);
        return () => { live = false; };
    }, [client, isAdmin, waManaged]);

    async function saveAuto(body: { enabled?: boolean; quietMinutes?: number }) {
        if (!client) return;
        setSavingAuto(true);
        try {
            const next = await client.setWhatsappAutoUpdate(body);
            setWa(next);
            setMinutes(String(next.autoUpdate.quietMinutes));
        } catch (e) {
            toast.error("Could not save the automatic update setting", { description: errorMessage(e) });
            if (wa) setMinutes(String(wa.autoUpdate.quietMinutes));
        } finally {
            setSavingAuto(false);
        }
    }
    function commitMinutes() {
        const n = Math.round(Number(minutes));
        if (!wa || !Number.isFinite(n) || n < 5 || n > 1440) { if (wa) setMinutes(String(wa.autoUpdate.quietMinutes)); return; }
        if (n !== wa.autoUpdate.quietMinutes) void saveAuto({ quietMinutes: n });
    }

    if (!isAdmin) return null;

    const live = status?.activeSessions ?? 0;

    async function apply(item: UpdateItem, forceWhatsapp = false) {
        if (!client) return;
        setBusy(item.target);
        try {
            // The confirmation dialog already told the admin how many sessions the restart stops.
            const result = await client.applyUpdate(item.target, item.target === "whatsapp" ? forceWhatsapp : item.target === "runtime" && live > 0);
            toast.success(`${LABELS[item.target]} updated`, {
                description: result.restarting ? "The runtime is restarting; the app will reconnect shortly." : "New sessions will use the new version.",
            });
            if (!result.restarting) await check(true);
        } catch (e) {
            if (e instanceof RuntimeError && e.code === "whatsapp_busy") { setForcing({ item, message: e.message }); return; }
            toast.error(`Could not update ${LABELS[item.target]}`, { description: errorMessage(e) });
        } finally {
            setBusy(null);
        }
    }

    return (
        <SettingsGroup title="Updates">
            <SettingRow settingId="about-updates"
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
                    {item.updateAvailable && item.target === "whatsapp" && item.managed === false && (
                        <span className="max-w-56 text-right text-xs text-muted-foreground">Runs outside Floq: update it where it is hosted</span>
                    )}
                    {item.updateAvailable && !(item.target === "whatsapp" && item.managed === false) && (
                        <Button size="sm" disabled={busy !== null} onClick={() => setConfirm(item)}>
                            {busy === item.target && <Spinner />}
                            Update
                        </Button>
                    )}
                </SettingRow>
            ))}
            {waManaged && wa && (
                <>
                    <SettingRow settingId="runtime-whatsapp-auto-update" label="Update the WhatsApp server automatically"
                        description={`Checks once a day and updates when no message was sent or received for ${wa.autoUpdate.quietMinutes} minutes, never during a QR login.`}>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Input type="number" inputMode="numeric" min={5} max={1440} className="h-8 w-20" aria-label="Quiet minutes before an automatic WhatsApp server update"
                                value={minutes} disabled={savingAuto} onChange={(e) => setMinutes(e.target.value)} onBlur={commitMinutes}
                                onKeyDown={(e) => { if (e.key === "Enter") commitMinutes(); }} />
                            min
                        </label>
                        <Switch checked={wa.autoUpdate.enabled} disabled={savingAuto} aria-label="Update the WhatsApp server automatically" onCheckedChange={(on) => void saveAuto({ enabled: on })} />
                    </SettingRow>
                    {wa.autoUpdate.last && (
                        <div data-slot="whatsapp-auto-update-last" className={`px-4 py-3 text-xs ${wa.autoUpdate.last.ok ? "text-muted-foreground" : "text-destructive"}`}>{formatResult(wa.autoUpdate.last)}</div>
                    )}
                </>
            )}
            <AlertDialog open={forcing !== null} onOpenChange={(open) => !open && setForcing(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>WhatsApp is in use</AlertDialogTitle>
                        <AlertDialogDescription>{forcing?.message || "Messages were sent or received recently."} Updating now interrupts WhatsApp for about a minute.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Not now</AlertDialogCancel>
                        <AlertDialogAction onClick={() => { const item = forcing?.item; setForcing(null); if (item) void apply(item, true); }}>Update anyway</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Update {confirm ? LABELS[confirm.target] : ""}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirm?.target === "whatsapp"
                                ? "WhatsApp disconnects for about a minute while the server restarts. Sessions and media are kept. If the new version does not come up healthy, Floq puts the previous one back."
                                : confirm?.target === "runtime"
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
