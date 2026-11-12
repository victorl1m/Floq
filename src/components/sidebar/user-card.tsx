import { IconBuilding, IconLogout, IconMailOpened, IconPalette, IconPlus, IconRefresh, IconSelector, IconSettings, IconUser } from "@tabler/icons-react";
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useIsAdmin } from "@/components/settings/use-admin";
import { useRuntime } from "@/lib/runtime/store";
import { OrganizationAvatar } from "@/components/organization/organization-avatar";
import { OrganizationHost } from "@/components/organization/organization-host";
import { organizationLabel, organizationUi, sortOrganizations, ROLE_LABEL, useOrganizationUi } from "@/lib/organizations";

function initials(label: string): string {
    const parts = label.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1][0] ?? "") : "")).toUpperCase();
}

export default function UserCard() {
    const { user, online, signOut, openSettings, organizations, organizationsLoading, organizationsError, refreshOrganizations, activeOrganizationId, selectOrganization } = useRuntime();
    const isAdmin = useIsAdmin();
    const { incoming } = useOrganizationUi();
    const pendingInvites = incoming.length;
    if (!user) return null;
    const name = user.name?.trim() || user.email.split("@")[0];
    const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);
    const roleLabel = isAdmin ? "Administrator" : activeOrganization ? ROLE_LABEL[activeOrganization.role] : "Member";
    const organizationSubtitle = (activeOrganization ? organizationLabel(activeOrganization) : null) ?? (organizationsLoading ? "Loading organization…" : organizationsError ? "Organizations unavailable" : "No organization yet");

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <OrganizationHost />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            tooltip={`${name} · ${organizationSubtitle}`}
                            className="h-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
                        >
                            <Avatar size="sm" className="size-8">
                                <AvatarFallback>{initials(name)}</AvatarFallback>
                                <AvatarBadge className={online ? "bg-emerald-500" : "bg-muted-foreground"} />
                                {pendingInvites > 0 && <span role="img" aria-label={`${pendingInvites} pending organization invitation${pendingInvites === 1 ? "" : "s"}`} className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-sidebar" data-testid="invitation-badge" />}
                            </Avatar>
                            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-semibold">{name}</span>
                                <span className="truncate text-xs text-muted-foreground">{organizationSubtitle}</span>
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
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <IconBuilding />
                                <span className="min-w-0 flex-1 truncate">{organizationSubtitle}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-56">
                                <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                                {organizationsLoading && <DropdownMenuItem disabled>Loading organizations…</DropdownMenuItem>}
                                {!organizationsLoading && organizationsError && <DropdownMenuItem onSelect={() => void refreshOrganizations()}><IconRefresh />Retry loading organizations</DropdownMenuItem>}
                                {!organizationsLoading && !organizationsError && organizations.length > 0 && <DropdownMenuRadioGroup value={activeOrganizationId ?? ""} onValueChange={selectOrganization}>
                                    {sortOrganizations(organizations).map((organization) => <DropdownMenuRadioItem key={organization.id} value={organization.id} textValue={organizationLabel(organization)} className="min-w-0"><OrganizationAvatar name={organizationLabel(organization)} className="size-5 rounded-md text-[0.6rem]" /><span className="truncate">{organizationLabel(organization)}</span></DropdownMenuRadioItem>)}
                                </DropdownMenuRadioGroup>}
                                {!organizationsLoading && !organizationsError && organizations.length === 0 && <DropdownMenuItem disabled>No organizations yet</DropdownMenuItem>}
                                <DropdownMenuSeparator />
                                {pendingInvites > 0 && <DropdownMenuItem onSelect={organizationUi.openInbox}><IconMailOpened />Pending invitations<Badge className="ml-auto">{pendingInvites}</Badge></DropdownMenuItem>}
                                <DropdownMenuItem onSelect={organizationUi.openCreate}><IconPlus />Create organization</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => openSettings("organization")}><IconSettings />Organization settings</DropdownMenuItem>
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
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
