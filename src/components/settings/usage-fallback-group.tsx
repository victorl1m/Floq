import { useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/runtime/store";
import type { FallbackStep, SettingsPatch, UsageFallback, UserSettings } from "@/lib/runtime/types";
import { SettingRow, SettingsGroup } from "./ui";

export const DEFAULT_USAGE_FALLBACK: UsageFallback = {
    enabled: true,
    steps: [
        { kind: "model", enabled: true, ladder: ["fable", "opus", "sonnet", "haiku"] },
        { kind: "account", enabled: false, slots: [] },
        { kind: "codex", enabled: false, model: "auto" },
    ],
    swapBack: true,
};

const STEP_TEXT: Record<FallbackStep["kind"], { label: string; description: string; soon?: boolean }> = {
    model: { label: "Smaller Claude model", description: "Opus → Sonnet → Haiku" },
    account: { label: "Another Claude account", description: "One you connected in LLM Providers" },
    codex: { label: "Codex", description: "Continues the same task in Codex" },
};

/** Settings > LLM Providers: the usage-limit fallback chain. Every step is optional and the order can be changed. */
export function UsageFallbackGroup({ settings, patch }: { settings: UserSettings; patch: (update: SettingsPatch & Partial<UserSettings>) => Promise<void> }) {
    const client = useClient();
    const value = settings.usageFallback ?? DEFAULT_USAGE_FALLBACK;
    // What the account and Codex steps could actually use right now (best effort: an older runtime just shows no hint).
    const [accountCount, setAccountCount] = useState<number | null>(null);
    const [codexConnected, setCodexConnected] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try { const accounts = await client.claudeAccounts(); if (!cancelled) setAccountCount(accounts.length); } catch { /* older runtime */ }
            try { const status = await client.providersStatus(); if (!cancelled) setCodexConnected(status.codex.connected); } catch { /* older runtime */ }
        })();
        return () => { cancelled = true; };
    }, [client]);
    const unavailable = (kind: FallbackStep["kind"]): string | null =>
        kind === "account" && accountCount !== null && accountCount < 2 ? "No second account connected, skipped"
        : kind === "codex" && codexConnected === false ? "Codex not connected, skipped"
        : null;
    const save = (next: UsageFallback) => void patch({ usageFallback: next });
    const setStep = (kind: FallbackStep["kind"], enabled: boolean) => save({ ...value, steps: value.steps.map((s) => (s.kind === kind ? { ...s, enabled } : s)) });
    const move = (index: number, by: -1 | 1) => {
        const steps = [...value.steps];
        const target = index + by;
        if (target < 0 || target >= steps.length) return;
        [steps[index], steps[target]] = [steps[target]!, steps[index]!];
        save({ ...value, steps });
    };

    return (
        <SettingsGroup title="Usage limits">
            <SettingRow settingId="accounts-fallback"
                label="Keep agents working"
                htmlFor="usage-fallback-enabled"
                description="When Claude hits its limit, try these in order. Otherwise the agent waits for the reset."
            >
                <Switch id="usage-fallback-enabled" checked={value.enabled} onCheckedChange={(v) => save({ ...value, enabled: v })} />
            </SettingRow>
            {value.enabled && <>
            <div className="flex flex-col divide-y divide-border" role="list" aria-label="Fallback order">
                {value.steps.map((step, index) => {
                    const text = STEP_TEXT[step.kind];
                    const id = `usage-fallback-${step.kind}`;
                    return (
                        <div key={step.kind} role="listitem" className="flex items-center gap-3 p-4">
                            <div className="flex flex-col">
                                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${text.label} up`} disabled={!value.enabled || index === 0} onClick={() => move(index, -1)}><IconArrowUp aria-hidden="true" /></Button>
                                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${text.label} down`} disabled={!value.enabled || index === value.steps.length - 1} onClick={() => move(index, 1)}><IconArrowDown aria-hidden="true" /></Button>
                            </div>
                            <div className="min-w-0 flex-1">
                                <label htmlFor={id} className="text-sm font-medium">{index + 1}. {text.label}</label>
                                <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{text.description}</p>
                                {unavailable(step.kind) && <p role="note" data-testid={`${id}-unavailable`} className="mt-1 max-w-prose text-xs leading-relaxed text-amber-600 dark:text-amber-400">{unavailable(step.kind)}</p>}
                            </div>
                            <Switch id={id} checked={step.enabled} disabled={!value.enabled} onCheckedChange={(v) => setStep(step.kind, v)} />
                        </div>
                    );
                })}
            </div>
            <SettingRow settingId="accounts-swapback" label="Switch back after the reset" htmlFor="usage-fallback-swapback" description="Once the agent is idle.">
                <Switch id="usage-fallback-swapback" checked={value.swapBack} disabled={!value.enabled} onCheckedChange={(v) => save({ ...value, swapBack: v })} />
            </SettingRow>
            </>}
        </SettingsGroup>
    );
}
