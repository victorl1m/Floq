import { IconLogout, IconSelector, IconSettings } from "@tabler/icons-react";
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
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
    const { user, online, signOut, openSettings } = useRuntime();
    if (!user) return null;
    const name = user.name?.trim() || user.email.split("@")[0];

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            tooltip={user.email}
                            className="h-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
                        >
                            <Avatar size="sm" className="size-8">
                                <AvatarFallback>{initials(name)}</AvatarFallback>
                                <AvatarBadge className={online ? "bg-emerald-500" : "bg-muted-foreground"} />
                            </Avatar>
                            <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-semibold">{name}</span>
                                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                            </div>
                            <IconSelector className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" className="w-56">
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
