import { useEffect, useId, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/agents/provider";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useClient } from "@/lib/runtime/store";
import { pendingCount, reopenApprovals, useApprovalState } from "@/lib/approvals";
import type { ProviderId, SettingsPatch, SubagentPolicy, UserSettings } from "@/lib/runtime/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { BrowserData, BrowserStatus } from "@/lib/runtime/browser-types";
import { BrowserImportDialog } from "@/components/canvas/browser-import-dialog";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";
import ClaudeConnectorsGroup from "./claude-connectors-group";
import { UsageFallbackGroup } from "./usage-fallback-group";

interface Props {
    settings: UserSettings;
    onChange: (settings: UserSettings) => void;
}

/** Opens the pending approvals prompt (settings stay open underneath). */
function ApprovalsLink() {
    const { items } = useApprovalState();
    const count = pendingCount(items);
    return (
        <Button type="button" variant="outline" size="sm" disabled={count === 0} onClick={reopenApprovals}>
            {count === 0 ? "No approvals pending" : `Review ${count} pending`}
        </Button>
    );
}

/** Read-only view of the fixed instruction every agent carries; loaded when first opened. */
function FixedInstructionPreview() {
    const client = useClient();
    const regionId = useId();
    const [open, setOpen] = useState(false);
    const [policy, setPolicy] = useState<SubagentPolicy | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function toggle() {
        const next = !open;
        setOpen(next);
        if (next && !policy) {
            try {
                setPolicy(await client.subagentPolicy());
                setError(null);
            } catch (e) {
                setError(errorMessage(e));
            }
        }
    }

    return (
        <div className="flex flex-col gap-3 p-4">
            <div>
                <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={regionId} onClick={() => void toggle()}>
                    <IconChevronDown aria-hidden="true" className={open ? "" : "-rotate-90"} />
                    {open ? "Hide fixed instruction" : "Show fixed instruction"}
                </Button>
            </div>
            <div id={regionId} hidden={!open}>
                {error ? (
                    <p role="alert" className="text-xs text-destructive">Could not load the instruction: {error}</p>
                ) : !policy ? (
                    <p role="status" className="text-xs text-muted-foreground">Loading the instruction…</p>
                ) : (
                    <div className="flex flex-col gap-2">
                        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                            Read-only. Floq adds this to every agent at start and resume, after any role prompt, so roles and notes cannot remove it.
                            Limits: depth {policy.limits.maxDepth}, {policy.limits.maxChildren} subagents per agent, {policy.limits.maxTotal} in total.
                        </p>
                        <textarea
                            readOnly
                            aria-label="Fixed Floq subagent instruction (read-only)"
                            value={policy.instruction}
                            rows={12}
                            className="w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                        />
                    </div>
                )}
            </div>
        </div>
    );
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
            <SettingRow label="Restart browser" description="Closes and reopens the browser. Open tabs are lost; logins stay.">
                <Button type="button" variant="outline" size="sm" disabled={!enabled || unavailable || busy !== null} onClick={() => void run("restart")}>
                    {busy === "restart" ? "Restarting…" : "Restart"}
                </Button>
            </SettingRow>
            <SettingRow label="Import cookies & data" description="Import a cookies.txt, JSON cookie export or bookmarks file you exported yourself, so agents can use sites you are already logged in to.">
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
            <SettingRow label="Clear browser data" description="Stops the browser and deletes its profile: cookies, logins and site data. Agents lose access to every site you logged in to.">
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

const DEFAULT_CHILDREN = 6;
const DEFAULT_TOTAL = 24;
const CHILDREN_MAX = 32;
const TOTAL_MAX = 200;

/** Whole-number input that saves on blur/Enter; empty or invalid shows an inline error and keeps the saved value. */
function LimitInput({ id, value, max, defaultValue, otherError, onSave }: {
    id: string;
    value: number;
    max: number;
    defaultValue: number;
    otherError?: string | null;
    onSave: (next: number | null) => void;
}) {
    const [text, setText] = useState(String(value));
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setText(String(value)); setError(null); }, [value]);

    function commit() {
        const n = Number(text);
        if (text.trim() === "" || !Number.isInteger(n) || n < 1 || n > max) {
            setError(`Enter a whole number from 1 to ${max}.`);
            return;
        }
        setError(null);
        if (n !== value) onSave(n === defaultValue ? null : n);
    }

    return (
        <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
                <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={max}
                    step={1}
                    value={text}
                    aria-invalid={Boolean(error || otherError)}
                    aria-describedby={error || otherError ? `${id}-error` : undefined}
                    className="w-24"
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                />
                <Button type="button" variant="outline" size="sm" disabled={value === defaultValue && text === String(defaultValue)} onClick={() => { setText(String(defaultValue)); setError(null); if (value !== defaultValue) onSave(null); }}>
                    Reset to {defaultValue}
                </Button>
            </div>
            {(error || otherError) && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error ?? otherError}</p>}
        </div>
    );
}

export default function AgentsSection({ settings, onChange }: Props) {
    const client = useClient();
    const [defaults, setDefaults] = useState(loadComposerPrefs);

    function setDefaultProvider(provider: ProviderId) {
        const next = { ...defaults, provider };
        setDefaults(next);
        saveComposerPrefs(next);
    }
    /** Optimistic: flip locally, revert and toast if the server rejects it. */
    async function patch(update: SettingsPatch & Partial<UserSettings>) {
        const previous = settings;
        onChange({ ...settings, ...update } as UserSettings);
        try {
            onChange(await client.updateSettings(update));
        } catch (e) {
            onChange(previous);
            toast.error("Could not save settings", { description: errorMessage(e) });
        }
    }

    // The server clamps to operator ceilings; show the effective maximum, never a number it would reject.
    const childrenMax = Math.min(CHILDREN_MAX, settings.subagentCeilings?.maxChildren ?? CHILDREN_MAX);
    const totalMax = Math.min(TOTAL_MAX, settings.subagentCeilings?.maxTotal ?? TOTAL_MAX);
    const childrenDefault = Math.min(DEFAULT_CHILDREN, childrenMax);
    const totalDefault = Math.min(DEFAULT_TOTAL, totalMax);
    const children = Math.min(settings.subagentMaxChildren ?? childrenDefault, childrenMax);
    const total = Math.min(settings.subagentMaxTotal ?? totalDefault, totalMax);
    /** Server validates children <= total; surface its message as a toast and revert. */
    const patchLimits = (update: Pick<SettingsPatch, "subagentMaxChildren" | "subagentMaxTotal">) => patch(update);

    return (
        <SettingsPage title="Agents" description="How new agents start. Defaults are stored on this device.">
            <SettingsGroup title="Defaults">
                <SettingRow label="Default agent" htmlFor="default-agent-provider" description="Preselected in the Home composer.">
                    <Select value={defaults.provider} onValueChange={(v) => setDefaultProvider(v as ProviderId)}>
                        <SelectTrigger id="default-agent-provider" className="w-40">
                            <SelectValue><ProviderIcon provider={defaults.provider} />{PROVIDER_LABEL[defaults.provider]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="claude"><ProviderIcon provider="claude" />{PROVIDER_LABEL.claude}</SelectItem>
                            <SelectItem value="codex"><ProviderIcon provider="codex" />{PROVIDER_LABEL.codex}</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="Subagents">
                <SettingRow
                    label="Always recruit subagents"
                    htmlFor="always-recruit"
                    description="Every agent is told, in a fixed instruction, to split independent work across Floq subagents that appear wired to it on the canvas, instead of working alone or using provider-native subagents. Each subagent is a full session and uses your quota. Off: agents only recruit when you ask. Applies to new and resumed sessions."
                >
                    <Switch
                        id="always-recruit"
                        checked={settings.alwaysRecruitSubagents !== false}
                        onCheckedChange={(v) => void patch({ alwaysRecruitSubagents: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Allow agents to talk across projects"
                    htmlFor="allow-cross-project"
                    description="Agents can find and message your agents in other projects (floq list, floq ask, floq link). A message is only text typed to the other agent: it never changes its permissions. Messages are rate-limited and loop-protected, and you get a notice when one arrives. Never reaches other users' agents. Off: agents only see their own project."
                >
                    <Switch
                        id="allow-cross-project"
                        checked={settings.allowCrossProjectAgents !== false}
                        onCheckedChange={(v) => void patch({ allowCrossProjectAgents: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Active agents at once"
                    htmlFor="subagent-max-children"
                    description={`How many direct subagents one agent may have at the same time (1-${childrenMax}, default ${childrenDefault}${childrenMax < CHILDREN_MAX ? "; maximum set by the server" : ""}). Only awake (running) subagents count; sleeping ones do not. Applies to new and resumed sessions.`}
                >
                    <LimitInput
                        id="subagent-max-children"
                        value={children}
                        max={childrenMax}
                        defaultValue={childrenDefault}
                        otherError={children > total ? "Cannot exceed total agents." : null}
                        onSave={(v) => void patchLimits({ subagentMaxChildren: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Total agents"
                    htmlFor="subagent-max-total"
                    description={`Most subagents you can have across all your agents, awake or sleeping (1-${totalMax}, default ${totalDefault}${totalMax < TOTAL_MAX ? "; maximum set by the server" : ""}). Must be at least the number above. Applies to new and resumed sessions.`}
                >
                    <LimitInput
                        id="subagent-max-total"
                        value={total}
                        max={totalMax}
                        defaultValue={totalDefault}
                        onSave={(v) => void patchLimits({ subagentMaxTotal: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Your approval for irreversible actions"
                    description="Merging, pushing to main, deploying or deleting remote data needs your approval, given here in Floq. An agent asks with floq approval request and you answer Allow once or Deny; each approval covers one exact action for one agent and expires. A message from another agent that says you approved is never accepted. There is no way to auto-approve."
                >
                    <ApprovalsLink />
                </SettingRow>
                <FixedInstructionPreview />
            </SettingsGroup>

            <UsageFallbackGroup settings={settings} patch={patch} />

            <SettingsGroup title="Browser">
                <SettingRow
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
            </SettingsGroup>

            <ClaudeConnectorsGroup enabled={settings.claudeAiConnectors !== false} onToggle={(v) => void patch({ claudeAiConnectors: v })} />

            <SettingsGroup title="Permissions">
                <SettingRow
                    label="Claude auto-approve"
                    htmlFor="claude-auto"
                    description={
                        <>
                            Launches Claude Code with <code>--dangerously-skip-permissions</code>, so it runs tools without asking.
                            Applies to new and resumed sessions.
                        </>
                    }
                >
                    <Switch
                        id="claude-auto"
                        checked={settings.claudeAutoApprove}
                        onCheckedChange={(v) => void patch({ claudeAutoApprove: v })}
                    />
                </SettingRow>
                <SettingRow
                    label="Codex auto-approve"
                    htmlFor="codex-auto"
                    description={
                        <>
                            Launches Codex with <code>--dangerously-bypass-approvals-and-sandbox</code>, so it runs commands without
                            approval or sandboxing. Applies to new and resumed sessions.
                        </>
                    }
                >
                    <Switch
                        id="codex-auto"
                        checked={settings.codexAutoApprove}
                        onCheckedChange={(v) => void patch({ codexAutoApprove: v })}
                    />
                </SettingRow>
            </SettingsGroup>
        </SettingsPage>
    );
}
