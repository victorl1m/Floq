import { IconHome, IconLock, IconSearch, IconSparkles, IconTerminal2 } from "@tabler/icons-react";
import { Kbd } from "@/components/ui/kbd";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from "@/components/ui/sidebar";
import CommandPalette from "@/components/sidebar/command-palette";
import ProjectList from "@/components/sidebar/project-list";
import UserCard from "@/components/sidebar/user-card";
import { useRuntime, type View } from "@/lib/runtime/store";

const NAV: { view: View; label: string; icon: typeof IconHome }[] = [
    { view: "home", label: "Home", icon: IconHome },
    { view: "skills", label: "Skills & MCP", icon: IconSparkles },
    { view: "secrets", label: "Secrets", icon: IconLock },
    { view: "terminal", label: "Terminal", icon: IconTerminal2 },
];

export function AppSidebar() {
    const { view, navigate, setSearchOpen } = useRuntime();

    return (
        <>
            <Sidebar
                collapsible="icon"
                className="border-r-0"
                style={{ top: 40, bottom: "var(--app-footer-height)", height: "auto" }}
            >
                <SidebarHeader>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                tooltip="Search"
                                className="h-9 bg-sidebar-accent/60 text-muted-foreground"
                                onClick={() => setSearchOpen(true)}
                            >
                                <IconSearch />
                                <span>Search</span>
                                <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">Ctrl K</Kbd>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarHeader>
                <SidebarContent>
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <SidebarMenu className="gap-1 group-data-[collapsible=icon]:gap-0">
                                {NAV.map((item) => (
                                    <SidebarMenuItem key={item.view}>
                                        <SidebarMenuButton
                                            tooltip={item.label}
                                            isActive={view === item.view}
                                            className="h-9"
                                            onClick={() => navigate(item.view)}
                                        >
                                            <item.icon />
                                            <span>{item.label}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                ))}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                    <ProjectList />
                </SidebarContent>
                <SidebarFooter>
                    <UserCard />
                </SidebarFooter>
                <SidebarRail />
            </Sidebar>
            <CommandPalette />
        </>
    );
}
