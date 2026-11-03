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
    const { user, online, signOut, openSettings, navigate, teams, teamsLoading, teamsError, refreshTeams, activeTeamId, selectTeam } = useRuntime();
    if (!user) return null;
    const name = user.name?.trim() || user.email.split("@")[0];
    const activeTeam = teams.find((team) => team.id === activeTeamId);
    const teamSubtitle = activeTeam?.name ?? (teamsLoading ? "Loading team…" : teamsError ? "Teams unavailable" : "No team yet");

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            tooltip={`${name} · ${teamSubtitle}`}
                            className="h-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
                        >
                            <Avatar size="sm" className="size-8">
                                <AvatarFallback>{initials(name)}</AvatarFallback>
                                <AvatarBadge className={online ? "bg-emerald-500" : "bg-muted-foreground"} />
                            </Avatar>
                            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-semibold">{name}</span>
                                <span className="truncate text-xs text-muted-foreground">{teamSubtitle}</span>
                            </div>
                            <IconSelector className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" className="w-56">
                        <DropdownMenuLabel>Teams</DropdownMenuLabel>
                        {teamsLoading && <DropdownMenuItem disabled>Loading teams…</DropdownMenuItem>}
                        {!teamsLoading && teamsError && <DropdownMenuItem onSelect={() => void refreshTeams()}><IconRefresh />Retry loading teams</DropdownMenuItem>}
                        {!teamsLoading && !teamsError && teams.length > 0 && <DropdownMenuRadioGroup value={activeTeamId ?? ""} onValueChange={selectTeam}>
                            {teams.map((team) => <DropdownMenuRadioItem key={team.id} value={team.id} textValue={team.name} className="min-w-0"><IconChecklist /><span className="truncate">{team.name}</span></DropdownMenuRadioItem>)}
                        </DropdownMenuRadioGroup>}
                        {!teamsLoading && !teamsError && teams.length === 0 && <DropdownMenuItem onSelect={() => navigate("tasks")}><IconChecklist />Create your first team in Tasks</DropdownMenuItem>}
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
