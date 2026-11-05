import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
    IconAdjustmentsAlt,
    IconBrandGithub,
    IconBuilding,
    IconInfoCircle,
    IconCreditCard,
    IconPalette,
    IconGauge,
    IconRobot,
    IconServer,
    IconUser,
    IconUsers,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { UserSettings } from "@/lib/runtime/types";
import AccountsSection from "./accounts-section";
import AdvancedSection from "./advanced-section";
import AboutSection from "./about-section";
import AccountSection from "./account-section";
import AgentsSection from "./agents-section";
import AppearanceSection from "./appearance-section";
import PerformanceSection from "./performance-section";
import OrganizationSection from "./organization-section";
import GitSection from "./git-section";
import RuntimeSection from "./runtime-section";
import UsersSection from "./users-section";
import DesktopSection from "./desktop-section";
import { isTauri } from "@tauri-apps/api/core";
import { useIsAdmin } from "./use-admin";

type Item = { id: string; label: string; icon: ComponentType<{ className?: string }> };

const GROUPS: { title: string; items: Item[] }[] = [
    {
        title: "General",
        items: [
            { id: "account", label: "Account", icon: IconUser },
            { id: "organization", label: "Organization", icon: IconBuilding },
            { id: "accounts", label: "LLM Providers", icon: IconCreditCard },
            { id: "appearance", label: "Appearance", icon: IconPalette },
            { id: "performance", label: "Performance", icon: IconGauge },
        ],
    },
    {
        title: "Agents",
        items: [
            { id: "agents", label: "Agents", icon: IconRobot },
            { id: "git", label: "Git & GitHub", icon: IconBrandGithub },
        ],
    },
    {
        title: "App",
        items: [
            ...(isTauri() && /Windows/i.test(navigator.userAgent) ? [{ id: "desktop", label: "Desktop", icon: IconServer }] : []),
            { id: "runtime", label: "Runtime", icon: IconServer },
            { id: "advanced", label: "Advanced", icon: IconAdjustmentsAlt },
            { id: "about", label: "About", icon: IconInfoCircle },
        ],
    },
];

const ADMIN_GROUP = { title: "Administration", items: [{ id: "users", label: "Users", icon: IconUsers }] };

export default function SettingsDialog() {
    const { client, settingsOpen, setSettingsOpen, settingsSection, openSettings } = useRuntime();
    const [settings, setSettings] = useState<UserSettings | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const isAdmin = useIsAdmin();
    const groups = isAdmin ? [...GROUPS, ADMIN_GROUP] : GROUPS;
    const ALL = groups.flatMap((g) => g.items);
    const section = ALL.some((i) => i.id === settingsSection) ? settingsSection : "account";

    const reload = useCallback(async () => {
        if (!client) return;
        setLoadError(null);
        try {
            setSettings(await client.settings());
        } catch (e) {
            setLoadError(errorMessage(e));
            toast.error("Could not load settings", { description: errorMessage(e) });
        }
    }, [client]);

    useEffect(() => {
        if (settingsOpen) void reload();
    }, [settingsOpen, reload]);

    const needsSettings = ["agents", "git", "advanced"].includes(section);

    let content;
    if (needsSettings && !settings) {
        content = (
            <div role="status" aria-busy={!loadError} className="space-y-6">
                {loadError ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
                    <h2 className="text-sm font-medium">Could not load settings</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => void reload()}>Retry</Button>
                </div> : <><span className="sr-only">Loading settings</span><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64 max-w-full" />{[0, 1, 2].map((row) => <Skeleton key={row} className="h-24 w-full rounded-xl" />)}</>}
            </div>
        );
    } else if (section === "account") content = <AccountSection />;
    else if (section === "appearance") content = <AppearanceSection />;
    else if (section === "performance") content = <PerformanceSection />;
    else if (section === "agents" && settings) content = <AgentsSection settings={settings} onChange={setSettings} />;
    else if (section === "organization") content = <OrganizationSection />;
    else if (section === "accounts") content = <AccountsSection />;
    else if (section === "git" && settings) content = <GitSection settings={settings} onChange={setSettings} reload={reload} />;
    else if (section === "desktop") content = <DesktopSection />;
    else if (section === "runtime") content = <RuntimeSection />;
    else if (section === "users") content = <UsersSection />;
    else if (section === "advanced" && settings) content = <AdvancedSection settings={settings} onChange={setSettings} />;
    else content = <AboutSection />;

    return (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="settings-dialog flex h-[min(820px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[1120px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1120px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Configure Floq</DialogDescription>
        <div className="flex h-full min-h-0 flex-col md:flex-row">
            {/* Narrow widths: the nav collapses into a select. */}
            <div className="border-b border-border p-3 pr-12 md:hidden">
                <Select value={section} onValueChange={(v) => openSettings(v)}>
                    <SelectTrigger className="w-full" aria-label="Settings section">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {ALL.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <nav aria-label="Settings" className="settings-nav hidden w-[220px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-muted/30 p-4 md:flex">
                <div className="px-2 pb-1 pt-2 text-lg font-semibold tracking-tight">Settings</div>
                {groups.map((group) => (
                    <div key={group.title} className="flex flex-col gap-0.5">
                        <span className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.title}</span>
                        {group.items.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                aria-current={section === item.id ? "page" : undefined}
                                onClick={() => openSettings(item.id)}
                                className={cn(
                                    "flex h-9 items-center gap-2.5 rounded-xl px-2.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    section === item.id
                                        ? "bg-primary/10 font-medium text-primary-text"
                                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                                )}
                            >
                                <item.icon className="size-4" />
                                {item.label}
                            </button>
                        ))}
                    </div>
                ))}
            </nav>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
                <div className="mx-auto w-full max-w-[760px] px-5 pt-10 pb-8 sm:px-9">{content}</div>
            </div>
        </div>
        </DialogContent>
        </Dialog>
    );
}
