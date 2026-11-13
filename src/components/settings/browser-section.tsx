import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, useClient } from "@/lib/runtime/store";
import type { UserSettings } from "@/lib/runtime/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { BrowserData, BrowserStatus } from "@/lib/runtime/browser-types";
import { BrowserImportDialog } from "@/components/canvas/browser-import-dialog";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import { BrowserEgressSettings } from "./browser-egress-settings";
import { EGRESS_SETTINGS_EVENT } from "@/lib/browser-egress";
import { useSettingsPatch } from "./use-settings-patch";

interface Props {
    settings: UserSettings;
    onChange: (settings: UserSettings) => void;
}

const CLEAR_WORD = "clear";

/** Status line, restart and clear-data controls of the shared agent browser (docs/design/agent-browser.md §A.7). */
function BrowserControls({ enabled }: { enabled: boolean }) {
    const client = useClient();
    const [status, setStatus] = useState<BrowserStatus | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [busy, setBusy] = useState<"restart" | "clear" | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [typed, setTyped] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    const [data, setData] = useState<BrowserData | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);
    const loadData = () => client.browserData().then(setData, () => setData(null));
    async function removeDomain(domain: string) {
        setRemoving(domain);
        try { await client.browserRemoveDomain(domain); await loadData(); toast.success(`Removed cookies for ${domain}`); }
        catch (e) { toast.error("Could not remove that site", { description: errorMessage(e) }); }
        finally { setRemoving(null); }
    }

    useEffect(() => {
        let stopped = false;
        const load = () => client.browserStatus().then((s) => { if (!stopped) { setStatus(s); setLoadError(false); } }, () => { if (!stopped) setLoadError(true); });
        void load();
        void loadData();
        const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 5_000);
        return () => { stopped = true; clearInterval(timer); };
    }, [client, enabled]);

    async function run(kind: "restart" | "clear") {
        setBusy(kind);
        try {
            setStatus(kind === "restart" ? await client.browserRestart() : await client.browserClearData());
            if (kind === "clear") setData({ domains: [], bookmarks: 0 });
            toast.success(kind === "restart" ? "Browser restarted" : "Browser data cleared");
        } catch (e) {
            toast.error(kind === "restart" ? "Could not restart the browser" : "Could not clear browser data", { description: errorMessage(e) });
        } finally {
            setBusy(null);
            setConfirmOpen(false);
            setTyped("");
        }
    }

    const v = status?.version;
    const unavailable = status?.state === "unavailable";
    const line = loadError ? "Status unavailable on this server."
        : !status ? "Loading status…"
        : unavailable ? "Not installed in this server's image."
        : `${status.state === "running" ? "Running" : status.state === "starting" ? "Starting" : status.state === "disabled" ? "Off" : "Stopped"}`
            + (status.state === "running" ? ` · ${status.agents ?? 0} agent${status.agents === 1 ? "" : "s"} connected · ${status.tabs ?? 0} tab${status.tabs === 1 ? "" : "s"}` : "");
    return (
        <>
            <SettingRow label="Status" description={v ? `Chromium ${v.chromium} (${v.build === 'chromium' ? 'full build, new headless' : 'headless shell'} r${v.revision}) · Playwright MCP ${v.playwrightMcp} · profile ${status?.profile ?? "~/.floq/browser/profile"}` : "Chromium version appears when the browser is installed."}>
                <span role="status" data-testid="browser-status" className="text-xs text-muted-foreground">{line}</span>
            </SettingRow>
            <SettingRow settingId="browser-restart" label="Restart browser" description="Closes and reopens the browser. Each Browser node reopens its last page; logins stay.">
                <Button type="button" variant="outline" size="sm" disabled={!enabled || unavailable || busy !== null} onClick={() => void run("restart")}>
                    {busy === "restart" ? "Restarting…" : "Restart"}
                </Button>
            </SettingRow>
            <SettingRow settingId="browser-import" label="Import cookies & data" description="Import a cookies.txt, JSON cookie export or bookmarks file you exported yourself, so agents can use sites you are already logged in to.">
                <Button type="button" variant="outline" size="sm" data-testid="browser-import-open" disabled={!enabled || unavailable} onClick={() => setImportOpen(true)}>Import…</Button>
            </SettingRow>
            {data && (data.domains.length > 0 || data.bookmarks > 0) && (
                <SettingRow label="Sites with cookies" description={`${data.domains.length} site${data.domains.length === 1 ? "" : "s"} in the browser profile${data.bookmarks ? ` · ${data.bookmarks} bookmarks imported` : ""}. Remove one to log agents out of it.`}>
                    <ul data-testid="browser-domains" className="max-h-40 w-64 overflow-y-auto text-xs">
                        {data.domains.map((d) => (
                            <li key={d.domain} className="flex items-center gap-2 py-0.5">
                                <span className="min-w-0 flex-1 truncate">{d.domain} <span className="text-muted-foreground">({d.count})</span></span>
                                <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${d.domain}`} disabled={removing !== null} onClick={() => void removeDomain(d.domain)}>Remove</Button>
                            </li>
                        ))}
                    </ul>
                </SettingRow>
            )}
            <BrowserImportDialog client={client} open={importOpen} onOpenChange={setImportOpen} onDone={() => void loadData()} />
            <SettingRow settingId="browser-clear" label="Clear browser data" description="Stops the browser and deletes its profile: cookies, logins and site data. Agents lose access to every site you logged in to.">
                <Button type="button" variant="outline" size="sm" disabled={unavailable || busy !== null} onClick={() => setConfirmOpen(true)}>Clear data…</Button>
            </SettingRow>
            <AlertDialog open={confirmOpen} onOpenChange={(open) => { setConfirmOpen(open); if (!open) setTyped(""); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Clear all browser data?</AlertDialogTitle>
                        <AlertDialogDescription>This deletes cookies, logins and site data for the shared browser and cannot be undone. Type <code>{CLEAR_WORD}</code> to confirm.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <Input aria-label={`Type ${CLEAR_WORD} to confirm`} value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction disabled={typed.trim().toLowerCase() !== CLEAR_WORD || busy !== null} onClick={(e) => { e.preventDefault(); void run("clear"); }}>Clear data</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

export default function BrowserSection({ settings, onChange }: Props) {
    const client = useClient();
    const patch = useSettingsPatch(settings, onChange);
    return (
        <SettingsPage title="Browser" description="The shared headless browser your agents use, and how its traffic leaves your network.">
            <SettingsGroup title="Browser">
                <SettingRow settingId="browser-agent"
                    label="Agent browser"
                    htmlFor="agent-browser"
                    description="Gives your agents one shared headless browser (MCP server floq-browser) that you can watch and use on the canvas Browser node, for example to log in to a site. Agents can use sites you log in to here. Applies to new or restarted sessions."
                >
                    <Switch
                        id="agent-browser"
                        checked={settings.agentBrowser !== false}
                        onCheckedChange={(v) => void patch({ agentBrowser: v })}
                    />
                </SettingRow>
                <BrowserControls enabled={settings.agentBrowser !== false} />
                <BrowserEgressSettings
                    mode={settings.agentBrowserEgress ?? "server"}
                    onMode={async (mode) => { onChange(await client.updateSettings({ agentBrowserEgress: mode })); window.dispatchEvent(new CustomEvent(EGRESS_SETTINGS_EVENT, { detail: mode })); }}
                />
            </SettingsGroup>
        </SettingsPage>
    );
}
