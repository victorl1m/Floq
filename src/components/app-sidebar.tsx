import { IconHome, IconLock, IconSearch, IconSparkles, IconTerminal2, IconChecklist } from "@tabler/icons-react";
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
    useSidebar,
} from "@/components/ui/sidebar";
import CommandPalette from "@/components/sidebar/command-palette";
import ProjectList from "@/components/sidebar/project-list";
import UserCard from "@/components/sidebar/user-card";
import { useRuntime, type View } from "@/lib/runtime/store";

const NAV: { view: View; label: string; icon: typeof IconHome }[] = [
    { view: "home", label: "Home", icon: IconHome },
    { view: "tasks", label: "Tasks", icon: IconChecklist },
    { view: "skills", label: "Skills & MCP", icon: IconSparkles },
    { view: "secrets", label: "Secrets", icon: IconLock },
    { view: "terminal", label: "Terminal", icon: IconTerminal2 },
];

export function AppSidebar() {
    const { view, navigate, setSearchOpen } = useRuntime();
    const { setOpenMobile } = useSidebar();

    return (
        <>
            <Sidebar
                aria-label="Workspace navigation"
                collapsible="offcanvas"
                className="border-r-0"
            >
                <SidebarHeader>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <div className="floq-surface sidebar-search min-w-0 rounded-[10px]">
                                <SidebarMenuButton
                                    tooltip="Search"
                                    className="h-9 rounded-[inherit] border-0 bg-transparent text-muted-foreground shadow-none hover:bg-transparent"
                                    onClick={() => { setOpenMobile(false); setSearchOpen(true); }}
                                >
                                    <IconSearch />
                                    <span>Search</span>
                                    <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">Ctrl K</Kbd>
                                </SidebarMenuButton>
                            </div>
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
                                            aria-current={view === item.view ? "page" : undefined}
                                            className="h-9"
                                            onClick={() => { navigate(item.view); setOpenMobile(false); }}
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
            </Sidebar>
            <CommandPalette />
        </>
    );
}
