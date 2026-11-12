import { IconMailOpened, IconPlus, IconRefresh, IconSelector, IconSettings } from "@tabler/icons-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { OrganizationAvatar } from "@/components/organization/organization-avatar";
import { organizationLabel, organizationUi, sortOrganizations, ROLE_LABEL, useOrganizationUi } from "@/lib/organizations";
import { useRuntime } from "@/lib/runtime/store";

/** Top-of-sidebar organization block (avatar, name, role line, chevron) that opens the organization list. It owns the pixel-dot ornament. */
export default function OrgSwitcher() {
    const { user, organizations, organizationsLoading, organizationsError, refreshOrganizations, activeOrganizationId, selectOrganization, openSettings } = useRuntime();
    const { incoming } = useOrganizationUi();
    if (!user) return null;
    const pendingInvites = incoming.length;
    const active = organizations.find((organization) => organization.id === activeOrganizationId);
    const name = (active ? organizationLabel(active) : null) ?? (organizationsLoading ? "Loading…" : organizationsError ? "Organizations unavailable" : "No organization");
    const subline = active ? `${ROLE_LABEL[active.role]} · ${organizations.length} organization${organizations.length === 1 ? "" : "s"}` : "Choose an organization";

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            tooltip={`${name} · ${subline}`}
                            data-testid="org-switcher"
                            className="h-14 rounded-[12px] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
                        >
                            <OrganizationAvatar name={active ? organizationLabel(active) : "?"} imageUrl={active?.imageUrl} className="size-9 rounded-[10px]" />
                            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-semibold">{name}</span>
                                <span className="truncate text-xs text-muted-foreground">{subline}</span>
                            </div>
                            <IconSelector className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="start" className="w-60">
                        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                        {organizationsLoading && <DropdownMenuItem disabled>Loading organizations…</DropdownMenuItem>}
                        {!organizationsLoading && organizationsError && <DropdownMenuItem onSelect={() => void refreshOrganizations()}><IconRefresh />Retry loading organizations</DropdownMenuItem>}
                        {!organizationsLoading && !organizationsError && organizations.length > 0 && <DropdownMenuRadioGroup value={activeOrganizationId ?? ""} onValueChange={selectOrganization}>
                            {sortOrganizations(organizations).map((organization) => <DropdownMenuRadioItem key={organization.id} value={organization.id} textValue={organizationLabel(organization)} className="min-w-0"><OrganizationAvatar name={organizationLabel(organization)} imageUrl={organization.imageUrl} className="size-5 rounded-md text-[0.6rem]" /><span className="truncate">{organizationLabel(organization)}</span></DropdownMenuRadioItem>)}
                        </DropdownMenuRadioGroup>}
                        {!organizationsLoading && !organizationsError && organizations.length === 0 && <DropdownMenuItem disabled>No organizations yet</DropdownMenuItem>}
                        <DropdownMenuSeparator />
                        {pendingInvites > 0 && <DropdownMenuItem onSelect={organizationUi.openInbox}><IconMailOpened />Pending invitations<Badge className="ml-auto">{pendingInvites}</Badge></DropdownMenuItem>}
                        <DropdownMenuItem onSelect={organizationUi.openCreate}><IconPlus />Create organization</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openSettings("organization")}><IconSettings />Organization settings</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
