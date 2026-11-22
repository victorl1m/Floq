import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { IconBrandWhatsapp, IconChevronDown, IconExternalLink, IconPlugConnected } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { WhatsappServerStatus, WhatsappServerTest } from "@/lib/runtime/admin-types";
import type { PluginInfo, PluginSettingValues } from "@/lib/runtime/types";
import { PluginBoundary, usePlugins } from "@/plugins/host";
import { WHATSAPP_PLUGIN_ID } from "@/plugins/integrations";
import { PluginSettingsForm } from "@/plugins/kit/plugin-settings-form";
import { PluginCredentials } from "./plugin-credentials";
import { SettingsGroup, SettingsPage } from "./ui";
import { useIsAdmin } from "./use-admin";
import { WHATSAPP_NOTICE, WhatsappServerCard } from "./whatsapp-server-card";
import { accountLine, connectionOf, serverMode, webhookLine, type WaAccount, type WaSession } from "./integrations-model";

/** The view of the WhatsApp inbox (`<plugin id>/<view id>`), opened from here and from the sidebar. */
const WHATSAPP_VIEW = `${WHATSAPP_PLUGIN_ID}/inbox`;
const TONE = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-destructive", off: "bg-muted-foreground/40" } as const;

function Row({ label, children, slot }: { label: string; children: React.ReactNode; slot?: string }) {
    return (
        <div className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4" data-slot={slot}>
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{children}</span>
        </div>
    );
}

/** Address + API key of a WAHA server the admin runs. "Save" only unlocks after these exact values passed the test. */
function ExternalServerForm({ current, onSaved, onCancel }: { current: string; onSaved: () => void; onCancel?: () => void }) {
    const { client } = useRuntime();
    const [baseUrl, setBaseUrl] = useState(current);
    const [apiKey, setApiKey] = useState("");
    const [busy, setBusy] = useState<"test" | "save" | null>(null);
    const [result, setResult] = useState<(WhatsappServerTest & { for: string }) | null>(null);
    const [failure, setFailure] = useState("");
    const signature = `${baseUrl.trim()}\n${apiKey}`;
    const tested = result?.ok === true && result.for === signature;
    const valid = /^https?:\/\/\S+$/i.test(baseUrl.trim()) && apiKey.trim().length > 0;

    async function test(event?: FormEvent) {
        event?.preventDefault();
        if (!client || !valid) return;
        setBusy("test"); setFailure(""); setResult(null);
        try { setResult({ ...(await client.testWhatsappServer(baseUrl.trim(), apiKey)), for: signature }); }
        catch (e) { setFailure(errorMessage(e)); }
        finally { setBusy(null); }
    }
    async function save() {
        if (!client || !tested) return;
        setBusy("save"); setFailure("");
        try {
            // The key first: a saved address without its key would point the integration at a server it cannot use.
            await client.setPluginSecret(WHATSAPP_PLUGIN_ID, "WAHA_API_KEY", apiKey);
            const settings = await client.getPluginSettings(WHATSAPP_PLUGIN_ID);
            await client.savePluginSettings(WHATSAPP_PLUGIN_ID, { ...settings, baseUrl: baseUrl.trim() });
            setApiKey(""); setResult(null);
            toast.success("WhatsApp server connected");
            onSaved();
        } catch (e) { setFailure(errorMessage(e)); }
        finally { setBusy(null); }
    }
    const verdict = !result || result.for !== signature ? null
        : result.ok ? `Connected${result.version ? `: WAHA ${result.version}` : ""}${result.engine ? ` (${result.engine})` : ""}. You can save it now.`
        : result.state === "unauthorized" ? "The server answered, but it refused this API key."
        : `The server could not be reached${result.error ? `: ${result.error}` : "."}`;

    return (
        <form onSubmit={test} noValidate className="space-y-3" data-slot="whatsapp-external-form">
            <Field>
                <FieldLabel htmlFor="whatsapp-external-url">WAHA address</FieldLabel>
                <Input id="whatsapp-external-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://waha.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                <FieldDescription>Where your WAHA server listens. Only this address is ever contacted.</FieldDescription>
            </Field>
            <Field>
                <FieldLabel htmlFor="whatsapp-external-key">API key</FieldLabel>
                <Input id="whatsapp-external-key" type="password" autoComplete="off" spellCheck={false} placeholder="The server's WAHA_API_KEY" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <FieldDescription>Stored encrypted on the runtime. It is never shown again and never reaches agents.</FieldDescription>
            </Field>
            <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="outline" size="sm" disabled={!valid || busy !== null}>{busy === "test" && <Spinner />}Test connection</Button>
                <Button type="button" size="sm" disabled={!tested || busy !== null} onClick={() => void save()}>{busy === "save" && <Spinner />}Save and connect</Button>
                {onCancel && <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={onCancel}>Cancel</Button>}
            </div>
            {verdict && <p role="status" data-slot="whatsapp-test-result" data-ok={result?.ok ? "true" : "false"} className={`text-xs ${result?.ok ? "text-foreground" : "text-destructive"}`}>{verdict}</p>}
            {failure && <p role="alert" className="text-xs text-destructive">{failure}</p>}
        </form>
    );
}

/** Live facts of the running integration, read from its own routes (they exist only while it is on, and only for the admin who owns it). */
function WhatsappStatus({ plugin, tick }: { plugin: PluginInfo; tick: number }) {
    const { client } = useRuntime();
    const [session, setSession] = useState<WaSession | null>(null);
    const [accounts, setAccounts] = useState<WaAccount[] | null>(null);
    const [failed, setFailed] = useState("");
    const load = useCallback(async () => {
        if (!client) return;
        setFailed("");
        try {
            const [s, a] = await Promise.all([
                client.pluginFetch<WaSession>(plugin.id, "/session"),
                client.pluginFetch<{ accounts: WaAccount[] }>(plugin.id, "/accounts").catch(() => ({ accounts: [] as WaAccount[] })),
            ]);
            setSession(s); setAccounts(a.accounts);
        } catch (e) { setFailed(errorMessage(e)); }
    }, [client, plugin.id]);
    useEffect(() => { void load(); }, [load, tick]);
    const [repairing, setRepairing] = useState(false);
    async function repair() {
        if (!client) return;
        setRepairing(true);
        try {
            const r = await client.pluginFetch<{ state?: string }>(plugin.id, "/session/webhook-repair", { method: "POST", body: {} });
            if (r.state === "ok") toast.success("Webhook repaired"); else toast.warning("The webhook still needs attention", { description: "Open WhatsApp to see what is wrong." });
            await load();
        } catch (e) { toast.error("Could not repair the webhook", { description: errorMessage(e) }); }
        finally { setRepairing(false); }
    }

    if (failed) return <Row label="Connection" slot="whatsapp-connection"><span className="text-destructive">{failed}</span><Button variant="outline" size="xs" onClick={() => void load()}>Retry</Button></Row>;
    if (!session) return <Row label="Connection" slot="whatsapp-connection"><span role="status" className="flex items-center gap-2 text-muted-foreground"><Spinner />Checking…</span></Row>;
    const connection = connectionOf(session);
    const hook = webhookLine(session);
    return (
        <>
            <Row label="Connection" slot="whatsapp-connection">
                <span className="flex min-w-0 items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${TONE[connection.tone]}`} aria-hidden /><span className="min-w-0">{connection.text}</span></span>
            </Row>
            <Row label="Accounts" slot="whatsapp-accounts">
                {accounts?.length ? (
                    <ul className="flex min-w-0 flex-col gap-1 sm:items-end">
                        {accounts.map((a) => <li key={a.session} className="min-w-0 truncate" data-account={a.session}>{accountLine(a)}</li>)}
                    </ul>
                ) : <span className="text-muted-foreground">No account linked yet. Open WhatsApp and scan the QR code.</span>}
            </Row>
            <Row label="Incoming messages" slot="whatsapp-webhook">
                <span className="flex min-w-0 items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${TONE[hook.tone]}`} aria-hidden /><span className="min-w-0">{hook.text}</span></span>
                {hook.repair && <Button variant="outline" size="xs" disabled={repairing} onClick={() => void repair()}>{repairing && <Spinner />}Repair webhook</Button>}
            </Row>
        </>
    );
}

function WhatsappSettings({ plugin, hideAddress }: { plugin: PluginInfo; hideAddress: boolean }) {
    const { client } = useRuntime();
    const { ui, refresh } = usePlugins();
    const [open, setOpen] = useState(false);
    const [values, setValues] = useState<PluginSettingValues | null>(null);
    const [failed, setFailed] = useState("");
    const load = useCallback(async () => {
        if (!client) return;
        setFailed("");
        try { setValues(await client.getPluginSettings(plugin.id)); } catch (e) { setFailed(errorMessage(e)); }
    }, [client, plugin.id]);
    useEffect(() => { if (open) void load(); }, [open, load]);
    // The server address has its own form above (it is tested before it is saved).
    const decls = useMemo(() => plugin.settings.filter((d) => d.key !== "baseUrl"), [plugin.settings]);
    const shown = useMemo(() => { if (!values) return null; const { baseUrl: _address, ...rest } = values; return rest; }, [values]);
    const Panel = plugin.enabled && plugin.userEnabled ? ui[plugin.id]?.settingsPanel : undefined;
    return (
        <div data-slot="whatsapp-settings">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40" aria-expanded={open} aria-controls="whatsapp-settings-region" onClick={() => setOpen((v) => !v)}>
                Settings
                <IconChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {open && (
                <div id="whatsapp-settings-region" className="space-y-5 border-t border-border p-4">
                    {Panel && <PluginBoundary pluginId={plugin.id}><Panel plugin={plugin} /></PluginBoundary>}
                    {!Panel && <p className="text-xs text-muted-foreground">Turn WhatsApp on to save your own number and send a test message.</p>}
                    {failed ? <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{failed}</p><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>
                        : !shown || !values ? <p role="status" className="text-sm text-muted-foreground">Loading settings…</p>
                        : (
                            <PluginSettingsForm
                                pluginId={plugin.id} decls={decls} values={shown}
                                onSave={async (next) => {
                                    if (!client) return;
                                    setValues(await client.savePluginSettings(plugin.id, { ...next, ...(typeof values.baseUrl === "string" && values.baseUrl ? { baseUrl: values.baseUrl } : {}) }));
                                    toast.success("WhatsApp settings saved");
                                }}
                            />
                        )}
                    {!hideAddress && <PluginCredentials plugin={plugin} isAdmin api={client} onChanged={() => void refresh()} />}
                </div>
            )}
        </div>
    );
}

/** Settings > Integrations > WhatsApp. Offered only when a WAHA server exists: the one compose runs beside Floq, or one the admin connected. */
function WhatsappIntegration() {
    const { client, navigate, setSettingsOpen } = useRuntime();
    const { all, loading, refresh } = usePlugins();
    const isAdmin = useIsAdmin();
    const plugin = all.find((p) => p.id === WHATSAPP_PLUGIN_ID);
    const [server, setServer] = useState<WhatsappServerStatus | null>(null);
    const [serverKnown, setServerKnown] = useState(false);
    const [busy, setBusy] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [address, setAddress] = useState("");
    const [tick, setTick] = useState(0);

    const loadServer = useCallback(async () => {
        if (!client || !isAdmin) return;
        try { setServer(await client.whatsappServer()); } catch { setServer(null); } finally { setServerKnown(true); }
        try { const s = await client.getPluginSettings(WHATSAPP_PLUGIN_ID); setAddress(typeof s.baseUrl === "string" ? s.baseUrl : ""); } catch { /* shown as not connected */ }
    }, [client, isAdmin]);
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => { void loadServer(); }, [loadServer]);

    const mode = serverMode(server, plugin, address);
    const available = mode !== "none";
    const on = Boolean(plugin?.enabled);
    const mine = Boolean(plugin?.enabled && plugin.userEnabled);

    async function toggle(next: boolean) {
        if (!client || !plugin) return;
        setBusy(true);
        try {
            await client.setPluginEnabled(plugin.id, next, "install");
            await refresh();
            setTick((n) => n + 1);
            toast.success(next ? "WhatsApp turned on" : "WhatsApp turned off");
        } catch (e) { toast.error(`Could not turn WhatsApp ${next ? "on" : "off"}`, { description: errorMessage(e) }); }
        finally { setBusy(false); }
    }
    async function disconnect() {
        if (!client) return;
        setBusy(true);
        try {
            const { baseUrl: _address, ...rest } = await client.getPluginSettings(WHATSAPP_PLUGIN_ID);
            await client.savePluginSettings(WHATSAPP_PLUGIN_ID, rest);
            await client.deletePluginSecret(WHATSAPP_PLUGIN_ID, "WAHA_API_KEY").catch(() => undefined);
            toast.success("External WhatsApp server disconnected");
            await Promise.all([loadServer(), refresh()]);
            setTick((n) => n + 1);
        } catch (e) { toast.error("Could not disconnect the server", { description: errorMessage(e) }); }
        finally { setBusy(false); }
    }
    const open = () => { setSettingsOpen(false); navigate("plugin", WHATSAPP_VIEW); };

    if (!plugin) {
        return (
            <SettingsGroup>
                <div className="p-4 text-sm text-muted-foreground" data-slot="whatsapp-integration" data-state="missing">
                    {loading ? <span role="status">Loading integrations…</span> : "This runtime does not include the WhatsApp integration yet. Update the runtime to use it."}
                </div>
            </SettingsGroup>
        );
    }
    const statusBadge = plugin.status === "failed" ? <Badge variant="destructive">Failed</Badge> : on ? <Badge variant="secondary">On</Badge> : <Badge variant="outline">Off</Badge>;
    return (
        <SettingsGroup>
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between" data-slot="whatsapp-integration" data-state={!isAdmin ? "member" : !serverKnown ? "loading" : mode} data-enabled={on ? "true" : "false"}>
                <div className="flex min-w-0 flex-1 gap-3">
                    <IconBrandWhatsapp className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">WhatsApp</span>
                            {statusBadge}
                            {isAdmin && serverKnown && <Badge variant="outline" data-slot="whatsapp-mode">{mode === "builtin" ? "Built-in server" : mode === "external" ? "External server" : "No server"}</Badge>}
                        </div>
                        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                            Your WhatsApp chats in Floq: several accounts, media, voice notes, reactions and groups. The AI can read them and message you on your own number; messages to other people need your approval.
                        </p>
                        {plugin.status === "failed" && <p className="text-xs text-destructive">It failed to start. Turn it on again to retry.</p>}
                    </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
                    {mine && <Button variant="outline" size="sm" onClick={open}><IconExternalLink aria-hidden /> Open WhatsApp</Button>}
                    {isAdmin && (available || on) && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            Enabled
                            <Switch checked={on} disabled={busy || (!available && !on)} aria-label={`${on ? "Disable" : "Enable"} WhatsApp`} onCheckedChange={(next) => void toggle(next)} />
                        </label>
                    )}
                </div>
            </div>

            {!isAdmin && (
                <p className="p-4 text-sm text-muted-foreground" data-slot="whatsapp-member-note">
                    {on ? (mine ? "WhatsApp is on for your account." : "WhatsApp is set up by an administrator of this runtime and belongs to their account.") : "An administrator of this runtime can set up WhatsApp here."}
                </p>
            )}

            {isAdmin && serverKnown && !available && (
                <div className="space-y-4 p-4" data-slot="whatsapp-no-server">
                    <div className="space-y-2 text-sm">
                        <p className="font-medium">WhatsApp needs a WhatsApp server (WAHA)</p>
                        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                            Floq talks to WhatsApp through <a className="underline underline-offset-2 hover:text-foreground" href="https://github.com/devlikeapro/waha" target="_blank" rel="noreferrer">WAHA</a>, a server that keeps your account linked. None is available to this runtime yet. Pick one:
                        </p>
                        <ol className="max-w-prose list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground">
                            <li>
                                <span className="text-foreground">Run the built-in server beside Floq.</span> On the machine that hosts the runtime, add these two lines to <code className="rounded bg-muted px-1 py-0.5 font-mono">runtime/.env</code> and run <code className="rounded bg-muted px-1 py-0.5 font-mono">docker compose up -d</code>. Floq then sets the address, the key and the webhook by itself.
                                <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">{"COMPOSE_PROFILES=whatsapp\nFLOQ_WHATSAPP_API_KEY=<openssl rand -hex 32>"}</pre>
                            </li>
                            <li><span className="text-foreground">Connect a WAHA server you already run.</span> Enter its address and API key below; Floq tests them before saving.</li>
                        </ol>
                    </div>
                    {connecting
                        ? <ExternalServerForm current={address} onSaved={() => { setConnecting(false); void loadServer(); void refresh(); }} onCancel={() => setConnecting(false)} />
                        : <Button variant="outline" size="sm" onClick={() => setConnecting(true)}><IconPlugConnected aria-hidden /> Connect a WAHA server</Button>}
                    <p className="max-w-prose text-xs text-muted-foreground">{WHATSAPP_NOTICE}</p>
                </div>
            )}

            {isAdmin && available && (
                <>
                    <Row label="Server" slot="whatsapp-server">
                        {mode === "external" ? (
                            <>
                                <span className="min-w-0 truncate font-mono text-xs" title={address}>{address || "External WAHA server"}</span>
                                <Button variant="outline" size="xs" disabled={busy} onClick={() => setConnecting((v) => !v)}>Change</Button>
                                <Button variant="ghost" size="xs" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
                            </>
                        ) : (
                            <>
                                <span>Built-in server beside Floq</span>
                                <Button variant="ghost" size="xs" onClick={() => setConnecting((v) => !v)}>Use another server</Button>
                            </>
                        )}
                    </Row>
                    {connecting && <div className="p-4"><ExternalServerForm current={mode === "external" ? address : ""} onSaved={() => { setConnecting(false); void loadServer(); void refresh(); setTick((n) => n + 1); }} onCancel={() => setConnecting(false)} /></div>}
                    {mine ? <WhatsappStatus plugin={plugin} tick={tick} />
                        : <Row label="Connection" slot="whatsapp-connection"><span className="text-muted-foreground">{on ? "WhatsApp belongs to the administrator who turned it on." : "Turn WhatsApp on, then open it to link your account with a QR code."}</span></Row>}
                    <WhatsappSettings plugin={plugin} hideAddress={mode === "builtin"} />
                    {server?.builtin.enabled && <div className="p-4"><WhatsappServerCard /></div>}
                </>
            )}
        </SettingsGroup>
    );
}

/** Settings > Integrations: services that are part of Floq and connect it to the outside. Plugins (Settings > Plugins) are installed separately. */
export default function IntegrationsSection() {
    return (
        <SettingsPage title="Integrations" description="Services built into Floq that connect it to the outside. Each one is off until an administrator sets it up.">
            <WhatsappIntegration />
        </SettingsPage>
    );
}
