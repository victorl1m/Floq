import type { ComponentType } from "react";
import { IconCode, IconCrown, IconEyeCheck, IconFileDescription, IconFlask, IconListCheck, IconSparkles, IconSubtask, IconUserCircle } from "@tabler/icons-react";

type RoleIcon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

/** Single source of truth for role icons/labels; reuse in every role-facing UI. */
export const GENERALIST_ROLE = "generalist";

const ICONS: Record<string, RoleIcon> = {
    generalist: IconSparkles,
    specifier: IconFileDescription,
    planner: IconListCheck,
    implementer: IconCode,
    reviewer: IconEyeCheck,
    tester: IconFlask,
    orchestrator: IconCrown,
    subagent: IconSubtask,
};

const LABELS: Record<string, string> = {
    generalist: "Generalist",
    specifier: "Specifier",
    planner: "Planner",
    implementer: "Implementer",
    reviewer: "Reviewer",
    tester: "Tester",
    orchestrator: "Orchestrator",
    subagent: "Subagent",
};

/** Icon component for a role id; unknown/custom roles get a neutral fallback. */
export function roleIcon(roleId: string | null | undefined): RoleIcon {
    return (roleId && ICONS[roleId.toLowerCase()]) || (roleId ? IconUserCircle : IconSparkles);
}

/** Display label: the runtime preset label when given, else a known label, else Title Case of the id. */
export function roleLabel(roleId: string | null | undefined, presetLabel?: string | null): string {
    if (presetLabel) return presetLabel;
    if (!roleId) return LABELS.generalist;
    const known = LABELS[roleId.toLowerCase()];
    if (known) return known;
    return roleId.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RoleGlyph({ roleId, size = 16, className }: { roleId: string | null | undefined; size?: number; className?: string }) {
    const Icon = roleIcon(roleId);
    return <Icon size={size} className={className} aria-hidden="true" />;
}
