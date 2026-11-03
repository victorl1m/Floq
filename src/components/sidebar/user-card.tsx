import { IconBuilding, IconChecklist, IconLogout, IconPalette, IconRefresh, IconSelector, IconSettings, IconUser } from "@tabler/icons-react";
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

function initials(label: string): string {
    const parts = label.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1][0] ?? "") : "")).toUpperCase();
}

export default function UserCard() {
    const { user, online, signOut, openSettings, navigate, organizations, organizationsLoading, organizationsError, refreshOrganizations, activeOrganizationId, selectOrganization } = useRuntime();
    const isAdmin = useIsAdmin();
    if (!user) return null;
    const name = user.name?.trim() || user.email.split("@")[0];
    const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);
    const roleLabel = isAdmin ? "Administrator" : activeOrganization?.role === "owner" ? "Owner" : "Member";
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
                                    {organizations.map((organization) => <DropdownMenuRadioItem key={organization.id} value={organization.id} textValue={organization.name} className="min-w-0"><IconChecklist /><span className="truncate">{organization.name}</span></DropdownMenuRadioItem>)}
                                </DropdownMenuRadioGroup>}
                                {!organizationsLoading && !organizationsError && organizations.length === 0 && <DropdownMenuItem onSelect={() => navigate("tasks")}><IconChecklist />Create your first organization in Tasks</DropdownMenuItem>}
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
