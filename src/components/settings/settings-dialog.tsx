import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
    IconAdjustmentsAlt,
    IconBrandGithub,
    IconInfoCircle,
    IconCreditCard,
    IconPalette,
    IconRobot,
    IconServer,
    IconUser,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "cn";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { UserSettings } from "@/lib/runtime/types";
import AccountsSection from "./accounts-section";
import AdvancedSection from "./advanced-section";
import AboutSection from "./about-section";
import AccountSection from "./account-section";
import AgentsSection from "./agents-section";
import AppearanceSection from "./appearance-section";
import GitSection from "./git-section";
import RuntimeSection from "./runtime-section";

type Item = { id: string; label: string; icon: ComponentType<{ className?: string }> };

const GROUPS: { title: string; items: Item[] }[] = [
    {
        title: "General",
        items: [
            { id: "account", label: "Account", icon: IconUser },
            { id: "accounts", label: "Accounts", icon: IconCreditCard },
            { id: "appearance", label: "Appearance", icon: IconPalette },
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
            { id: "runtime", label: "Runtime", icon: IconServer },
            { id: "advanced", label: "Advanced", icon: IconAdjustmentsAlt },
            { id: "about", label: "About", icon: IconInfoCircle },
        ],
    },
];

const ALL = GROUPS.flatMap((g) => g.items);

export default function SettingsDialog() {
    const { client, settingsOpen, setSettingsOpen, settingsSection, openSettings } = useRuntime();
    const [settings, setSettings] = useState<UserSettings | null>(null);
    const section = ALL.some((i) => i.id === settingsSection) ? settingsSection : "account";

    const reload = useCallback(async () => {
        if (!client) return;
        try {
            setSettings(await client.settings());
        } catch (e) {
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
            <div className="flex justify-center py-16">
                <Spinner />
            </div>
        );
    } else if (section === "account") content = <AccountSection />;
    else if (section === "appearance") content = <AppearanceSection />;
    else if (section === "agents" && settings) content = <AgentsSection settings={settings} onChange={setSettings} />;
    else if (section === "accounts") content = <AccountsSection />;
    else if (section === "git" && settings) content = <GitSection settings={settings} onChange={setSettings} reload={reload} />;
    else if (section === "runtime") content = <RuntimeSection />;
    else if (section === "advanced" && settings) content = <AdvancedSection settings={settings} onChange={setSettings} />;
    else content = <AboutSection />;

    return (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="flex h-[min(640px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[900px] max-w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Configure Floq</DialogDescription>
        <div className="flex h-full min-h-0 flex-col md:flex-row">
            {/* Narrow widths: the nav collapses into a select. */}
            <div className="border-b border-border p-3 pr-12 md:hidden">
                <Select value={section} onValueChange={(v) => openSettings(v)}>
                    <SelectTrigger className="w-full">
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

            <nav aria-label="Settings" className="hidden w-[200px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-muted/30 p-3 md:flex">
                {GROUPS.map((group) => (
                    <div key={group.title} className="flex flex-col gap-0.5">
                        <span className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.title}</span>
                        {group.items.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                aria-current={section === item.id ? "page" : undefined}
                                onClick={() => openSettings(item.id)}
                                className={cn(
                                    "flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    section === item.id
                                        ? "bg-muted font-medium text-foreground"
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

            <div className="mt-10 min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 md:mt-10">
                <div className="mx-auto w-full max-w-[640px] px-8 pt-2 pb-8">{content}</div>
            </div>
        </div>
        </DialogContent>
        </Dialog>
    );
}
