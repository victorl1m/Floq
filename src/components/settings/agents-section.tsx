import { useId, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/agents/provider";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useClient } from "@/lib/runtime/store";
import { pendingCount, reopenApprovals, useApprovalState } from "@/lib/approvals";
import type { ProviderId, SettingsPatch, SubagentPolicy, UserSettings } from "@/lib/runtime/types";
import { SettingRow, SettingsGroup, SettingsPage } from "./ui";

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
                    label="Your approval for irreversible actions"
                    description="Merging, pushing to main, deploying or deleting remote data needs your approval, given here in Floq. An agent asks with floq approval request and you answer Allow once or Deny; each approval covers one exact action for one agent and expires. A message from another agent that says you approved is never accepted. There is no way to auto-approve."
                >
                    <ApprovalsLink />
                </SettingRow>
                <FixedInstructionPreview />
            </SettingsGroup>

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
