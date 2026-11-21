import { useSyncExternalStore } from "react";
import type { IncomingOrganizationInvitation, OrganizationRole } from "@/lib/runtime/types";

/**
 * Organizations are user-wide: the list always comes from the runtime (see refreshOrganizations in the runtime store).
 * This module only holds UI state that several distant components share: the invitation inbox and which
 * organization dialogs are open. The active organization id is cached per user in user-preferences, never the list.
 *
 * Extension point: projects and agents are not owned by or shared with organizations yet.
 */

export const ROLE_LABEL: Record<OrganizationRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export const ROLE_SUMMARY: Record<OrganizationRole, string> = {
    owner: "Can do everything: edit the organization, change roles, transfer ownership and delete the organization.",
    admin: "Can edit the organization's name, URL name and image, invite members and remove members.",
    member: "Can see the organization and leave it.",
};

export const canManageMembers = (role: OrganizationRole | undefined) => role === "owner" || role === "admin";

export const SLUG_MAX = 40;
export const NAME_MAX = 64;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/** Mirrors the runtime's slug rules so the preview matches what will be stored. */
export function slugify(name: string): string {
    const base = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    if (!base) return "";
    return base.length >= 3 ? base : `${base}-org`;
}

export function isValidSlug(slug: string): boolean {
    return SLUG_PATTERN.test(slug) && !slug.includes("--");
}

export function organizationInitials(name: string): string {
    const parts = name.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1][0] ?? "") : "")).toUpperCase();
}

/** Generated-icon palette: [from, to] CSS colours built only from theme tokens (memory-type hues + primary). Light theme: white text; dark theme (lighter inks): background-coloured text. */
export const ORGANIZATION_PALETTE: ReadonlyArray<readonly [string, string]> = [
    ["var(--mem-fact-ink)", "var(--mem-fact)"],
    ["var(--mem-decision-ink)", "var(--mem-decision)"],
    ["var(--mem-procedure-ink)", "var(--mem-procedure)"],
    ["var(--mem-episode-ink)", "var(--mem-episode)"],
    ["var(--primary-text)", "var(--primary-hover)"],
];

/** Stable palette index for a name (FNV-1a over the trimmed, lower-cased name): same name, same colour, every render. */
export function organizationPaletteIndex(name: string): number {
    let hash = 0x811c9dc5;
    for (const ch of name.trim().toLowerCase()) {
        hash ^= ch.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % ORGANIZATION_PALETTE.length;
}

/** CSS background (a subtle diagonal gradient) of the generated icon for an organization name. */
export function organizationIconBackground(name: string): string {
    const [from, to] = ORGANIZATION_PALETTE[organizationPaletteIndex(name)];
    return `linear-gradient(135deg, ${from}, ${to})`;
}

export function formatExpiry(iso: string, now = Date.now()): string {
    const ms = Date.parse(iso) - now;
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "Expired";
    const days = Math.floor(ms / 864e5);
    if (days >= 1) return `Expires in ${days} day${days === 1 ? "" : "s"}`;
    const hours = Math.max(1, Math.floor(ms / 36e5));
    return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
}

interface UiState {
    incoming: IncomingOrganizationInvitation[];
    inboxLoaded: boolean;
    createOpen: boolean;
    inboxOpen: boolean;
}

let state: UiState = { incoming: [], inboxLoaded: false, createOpen: false, inboxOpen: false };
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
}

export const organizationUi = {
    snapshot: () => state,
    setIncoming: (incoming: IncomingOrganizationInvitation[]) => set({ incoming, inboxLoaded: true }),
    removeIncoming: (id: string) => set({ incoming: state.incoming.filter((invite) => invite.id !== id) }),
    openCreate: () => set({ createOpen: true }),
    setCreateOpen: (createOpen: boolean) => set({ createOpen }),
    openInbox: () => set({ inboxOpen: true }),
    setInboxOpen: (inboxOpen: boolean) => set({ inboxOpen }),
    reset: () => set({ incoming: [], inboxLoaded: false, createOpen: false, inboxOpen: false }),
};

export function useOrganizationUi(): UiState {
    return useSyncExternalStore(
        (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        () => state,
        () => state,
    );
}

/** Display order: the user's Personal organization first, the rest as the runtime returned them. */
export function sortOrganizations<T extends { personal?: boolean }>(organizations: T[]): T[] {
  return [...organizations.filter((o) => o.personal), ...organizations.filter((o) => !o.personal)];
}

/** Display name. The personal organization starts as "Personal" and can be renamed like any other. */
export function organizationLabel(organization: { name: string; personal?: boolean }): string {
  return organization.name.trim() || (organization.personal ? "Personal" : "Organization");
}
