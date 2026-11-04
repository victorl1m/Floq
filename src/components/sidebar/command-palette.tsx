import { useEffect, useRef, useState } from "react";
import { IconHome, IconPlus, IconSettings, IconSparkles, IconTerminal2, IconChecklist, IconLock, IconFolder, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
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
    const { sessions, projects, searchOpen, setSearchOpen, navigate, openCanvas, openSession, openSettings, setNewAgentOpen } =
        useRuntime();
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { if (!searchOpen) setQuery(""); }, [searchOpen]);

    const agents = sessions.filter((s) => s.provider !== "shell");

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.isComposing) return;
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
        <CommandDialog
            open={searchOpen}
            onOpenChange={setSearchOpen}
            title="Search"
            description="Jump to anything"
            className="top-[10vh] max-h-[calc(90dvh-1rem)] w-[calc(100vw-2rem)] max-w-[640px] translate-y-0 sm:max-w-[640px]"
        >
            <Command>
                <div className="relative">
                    <CommandInput ref={inputRef} value={query} onValueChange={setQuery} aria-label="Search workspace" placeholder="Search sessions, projects and settings…" className="pr-9" />
                    {query && <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear workspace search" className="absolute top-1.5 right-2" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><IconX /></Button>}
                </div>
                <CommandList className="max-h-[min(60dvh,480px)]">
                    <CommandEmpty>No results found.</CommandEmpty>
                    <CommandGroup heading="Go to">
                        <CommandItem onSelect={run(() => navigate("home"))}>
                            <IconHome />
                            Home
                        </CommandItem>
                        <CommandItem onSelect={run(() => navigate("tasks"))}>
                            <IconChecklist />Tasks
                        </CommandItem>
                        <CommandItem onSelect={run(() => navigate("skills"))}>
                            <IconSparkles />
                            Skills & MCP
                        </CommandItem>
                        <CommandItem onSelect={run(() => navigate("secrets"))}>
                            <IconLock />Secrets
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
                    {projects.length > 0 && <CommandGroup heading="Projects">
                        {projects.map((project) => <CommandItem key={project.id} value={`project ${project.displayName || project.name} ${project.id}`} onSelect={run(() => openCanvas(project.id))}>
                            <IconFolder /><span className="min-w-0 flex-1 truncate">{project.displayName || project.name}</span><CommandShortcut>Canvas</CommandShortcut>
                        </CommandItem>)}
                    </CommandGroup>}
                    {agents.length > 0 && (
                        <CommandGroup heading="Sessions">
                            {agents.map((session) => (
                                <CommandItem
                                    key={session.id}
                                    value={`${session.title} ${projectLabel(session.cwd)} ${session.id}`}
                                    onSelect={run(() => openSession(session))}
                                    className="min-w-0"
                                >
                                    <ProviderIcon provider={session.provider} />
                                    <span className="min-w-0 flex-1 truncate" title={session.title}>{session.title}</span>
                                    <CommandShortcut className="max-w-[40%] truncate" title={projectLabel(session.cwd)}>{projectLabel(session.cwd)}</CommandShortcut>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    )}
                </CommandList>
            </Command>
        </CommandDialog>
    );
}
