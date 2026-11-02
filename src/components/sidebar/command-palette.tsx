import { useEffect } from "react";
import { IconHome, IconPlus, IconSettings, IconSparkles, IconTerminal2 } from "@tabler/icons-react";
import {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandShortcut,
} from "@/components/ui/command";
import { ProviderIcon } from "@/components/agents/provider";
import { projectLabel } from "@/lib/runtime/projects";
import { useRuntime } from "@/lib/runtime/store";

/** Ctrl/Cmd+K palette to jump to views, sessions and settings. */
export default function CommandPalette() {
    const { sessions, searchOpen, setSearchOpen, navigate, openSession, openSettings, setNewAgentOpen } =
        useRuntime();

    const agents = sessions.filter((s) => s.provider !== "shell");

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            // Terminals keep Ctrl+K (kill-line in shells and TUIs).
            if (event.target instanceof Element && event.target.closest(".xterm")) return;
            if (event.key === "," && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                openSettings();
                return;
            }
            if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                setSearchOpen(!searchOpen);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [searchOpen, setSearchOpen, openSettings]);

    const run = (action: () => void) => () => {
        setSearchOpen(false);
        action();
    };

    return (
        <CommandDialog open={searchOpen} onOpenChange={setSearchOpen} title="Search" description="Jump to anything">
            <Command>
            <CommandInput placeholder="Search sessions, projects, skills and settings..." />
            <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup heading="Go to">
                    <CommandItem onSelect={run(() => navigate("home"))}>
                        <IconHome />
                        Home
                    </CommandItem>
                    <CommandItem onSelect={run(() => navigate("skills"))}>
                        <IconSparkles />
                        Skills & MCP
                    </CommandItem>
                    <CommandItem onSelect={run(() => navigate("terminal"))}>
                        <IconTerminal2 />
                        Terminal
                    </CommandItem>
                    <CommandItem onSelect={run(() => openSettings())}>
                        <IconSettings />
                        Settings
                    </CommandItem>
                    <CommandItem onSelect={run(() => setNewAgentOpen(true))}>
                        <IconPlus />
                        New agent
                    </CommandItem>
                </CommandGroup>
                {agents.length > 0 && (
                    <CommandGroup heading="Sessions">
                        {agents.map((session) => (
                            <CommandItem
                                key={session.id}
                                value={`${session.title} ${projectLabel(session.cwd)} ${session.id}`}
                                onSelect={run(() => openSession(session))}
                            >
                                <ProviderIcon provider={session.provider} />
                                {session.title}
                                <CommandShortcut>{projectLabel(session.cwd)}</CommandShortcut>
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}
            </CommandList>
            </Command>
        </CommandDialog>
    );
}
