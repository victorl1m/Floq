import { IconLogout, IconPalette, IconSelector, IconSettings, IconUser } from "@tabler/icons-react";
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useIsAdmin } from "@/components/settings/use-admin";
import { useRuntime } from "@/lib/runtime/store";
import { OrganizationHost } from "@/components/organization/organization-host";
import { OrganizationAvatar } from "@/components/organization/organization-avatar";
import { organizationLabel, ROLE_LABEL, useOrganizationUi } from "@/lib/organizations";

function initials(label: string): string {
    const parts = label.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1][0] ?? "") : "")).toUpperCase();
}

const PARTICLES = new Set(["e", "da", "de", "do", "dos", "das", "di", "du"]);
/** "Victor Hugo Lima e Silva" -> "Victor Silva": first word + last word, skipping trailing particles. */
export function shortName(label: string): string {
    const words = label.split(/\s+/).filter(Boolean);
    if (words.length < 2) return words[0] ?? label;
    let last = words.length - 1;
    while (last > 0 && PARTICLES.has(words[last].toLowerCase())) last -= 1;
    return last > 0 ? `${words[0]} ${words[last]}` : words[0];
}

export default function UserCard() {
    const { user, online, signOut, openSettings, organizations, activeOrganizationId } = useRuntime();
    const isAdmin = useIsAdmin();
    const { incoming } = useOrganizationUi();
    const pendingInvites = incoming.length;
    if (!user) return null;
    const name = user.name?.trim() || user.email.split("@")[0];
    const short = shortName(name);
    const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);
    const roleLabel = isAdmin ? "Administrator" : activeOrganization ? ROLE_LABEL[activeOrganization.role] : "Member";

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <OrganizationHost />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            tooltip={name}
                            aria-label={name}
                            className="h-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
                        >
                            <Avatar size="sm" className="size-8">
                                <AvatarFallback>{initials(short)}</AvatarFallback>
                                <AvatarBadge className={online ? "bg-emerald-500" : "bg-muted-foreground"} />
                                {pendingInvites > 0 && <span role="img" aria-label={`${pendingInvites} pending organization invitation${pendingInvites === 1 ? "" : "s"}`} className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-sidebar" data-testid="invitation-badge" />}
                            </Avatar>
                            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-semibold" title={name}>{short}</span>
                            </div>
                            <IconSelector className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" className="w-64">
                        <div className="flex items-center gap-3 px-2 py-2.5">
                            <Avatar className="size-10">
                                <AvatarFallback>{initials(name)}</AvatarFallback>
                            </Avatar>
                            <div className="grid min-w-0 flex-1 gap-1">
                                <span className="truncate text-sm font-semibold">{name}</span>
                                <Badge variant="outline" className="w-fit">{roleLabel}</Badge>
                            </div>
                        </div>
                        {activeOrganization && (
                            <div className="flex items-center gap-2 px-2 pb-2.5 text-xs text-muted-foreground" data-testid="account-menu-org">
                                <OrganizationAvatar name={organizationLabel(activeOrganization)} imageUrl={activeOrganization.imageUrl} className="size-5 rounded-md text-[0.6rem]" />
                                <span className="truncate">{organizationLabel(activeOrganization)}</span>
                            </div>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => openSettings("account")}>
                            <IconUser />
                            Account details
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openSettings()}>
                            <IconSettings />
                            Settings
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openSettings("appearance")}>
                            <IconPalette />
                            Appearance
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => void signOut()}>
                            <IconLogout />
                            Log out
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
