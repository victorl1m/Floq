import { IconChecklist, IconLogout, IconRefresh, IconSelector, IconSettings } from "@tabler/icons-react";
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useRuntime } from "@/lib/runtime/store";

function initials(label: string): string {
    const parts = label.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1][0] ?? "") : "")).toUpperCase();
}

export default function UserCard() {
    const { user, online, signOut, openSettings, navigate, organizations, organizationsLoading, organizationsError, refreshOrganizations, activeOrganizationId, selectOrganization } = useRuntime();
    if (!user) return null;
    const name = user.name?.trim() || user.email.split("@")[0];
    const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);
    const organizationSubtitle = activeOrganization?.name ?? (organizationsLoading ? "Loading organization…" : organizationsError ? "Organizations unavailable" : "No organization yet");

    return (
        <SidebarMenu>
            <SidebarMenuItem>
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
                            </Avatar>
                            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-semibold">{name}</span>
                                <span className="truncate text-xs text-muted-foreground">{organizationSubtitle}</span>
                            </div>
                            <IconSelector className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" className="w-56">
                        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                        {organizationsLoading && <DropdownMenuItem disabled>Loading organizations…</DropdownMenuItem>}
                        {!organizationsLoading && organizationsError && <DropdownMenuItem onSelect={() => void refreshOrganizations()}><IconRefresh />Retry loading organizations</DropdownMenuItem>}
                        {!organizationsLoading && !organizationsError && organizations.length > 0 && <DropdownMenuRadioGroup value={activeOrganizationId ?? ""} onValueChange={selectOrganization}>
                            {organizations.map((organization) => <DropdownMenuRadioItem key={organization.id} value={organization.id} textValue={organization.name} className="min-w-0"><IconChecklist /><span className="truncate">{organization.name}</span></DropdownMenuRadioItem>)}
                        </DropdownMenuRadioGroup>}
                        {!organizationsLoading && !organizationsError && organizations.length === 0 && <DropdownMenuItem onSelect={() => navigate("tasks")}><IconChecklist />Create your first organization in Tasks</DropdownMenuItem>}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => openSettings()}>
                            <IconSettings />
                            Settings
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
