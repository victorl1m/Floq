import {
    useEffect,
    useState,
    type ComponentProps,
    type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconArrowLeft, IconArrowRight, IconCopy, IconLayoutSidebarRight, IconMinus, IconSquare, IconTopologyStar3, IconX } from "@tabler/icons-react";
import { cn } from "cn";
import { setTitlebarSlot } from "@/lib/titlebar-slot";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import IconBrandFloq from "@/components/ui/brand/IconBrandFloq";
import { Button } from "@/components/ui/button"
import { useRuntime } from "@/lib/runtime/store";
import { toggleRightSidebar, useRightSidebar } from "@/lib/right-sidebar";


const appWindow = isTauri() ? getCurrentWindow() : null;

type TitlebarButtonProps = ComponentProps<"button"> & {
    label: string;
    children: ReactNode;
};

function TitlebarButton({
    label,
    className,
    children,
    ...props
}: TitlebarButtonProps) {
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            className={cn(
                "inline-flex h-full w-[46px] cursor-pointer items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                className
            )}
            {...props}
        >
            {children}
        </button>
    );
}

export default function Titlebar() {
    const [isMaximized, setIsMaximized] = useState(false);
    const { user, view, activeProjectId, canvasProjectId, openCanvas, canGoBack, canGoForward, goBack, goForward } = useRuntime();
    const rightSidebar = useRightSidebar();
    const { open: sidebarOpen, isMobile } = useSidebar();
    const sidebarUsesTitlebarWidth = sidebarOpen && !isMobile;
    const auth = !user;

    useEffect(() => {
        if (!appWindow) return;

        let cancelled = false;

        const syncMaximized = async () => {
            const maximized = await appWindow.isMaximized();
            if (!cancelled) setIsMaximized(maximized);
        };

        void syncMaximized();
        const unlisten = appWindow.onResized(() => void syncMaximized());

        return () => {
            cancelled = true;
            void unlisten.then((dispose) => dispose());
        };
    }, []);

    return (
        <header
            data-tauri-drag-region
            data-state={auth ? "auth" : "app"}
            className={cn(
                "pointer-events-auto fixed inset-x-0 top-0 z-40 flex h-[40px] items-center border-b text-foreground select-none space-between transition-colors duration-200",
                auth ? "floq-titlebar border-border/30 glass-surface" : "floq-titlebar border-border glass-surface"
            )}
        >

            <div
                data-tauri-drag-region
                className={cn(
                    "flex h-full items-center pl-3 transition-[width] duration-200",
                    auth ? "flex-1" : sidebarUsesTitlebarWidth ? "w-(--sidebar-width) shrink-0" : "shrink-0"
                )}
            >
                <IconBrandFloq size={20} className="text-muted-foreground transition-colors hover:text-foreground" />
                {auth && (
                    <span
                        data-tauri-drag-region
                        className="ml-2 animate-in fade-in-0 text-sm font-medium text-muted-foreground duration-200"
                    >
                        Floq
                    </span>
                )}
                {!auth && <SidebarTrigger className="animate-in text-muted-foreground! transition-colors fade-in-0 duration-200 hover:text-foreground!" />}
                {!auth && (
                    <div
                        data-tauri-drag-region
                        className={cn("flex animate-in items-center fade-in-0 duration-200", sidebarUsesTitlebarWidth ? "ml-auto pr-2" : "ml-1")}
                    >
                        <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!canGoBack} onClick={goBack}>
                            <IconArrowLeft />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Forward"
                            disabled={!canGoForward}
                            onClick={goForward}
                        >
                            <IconArrowRight />
                        </Button>
                    </div>
                )}
            </div>

            {/* Views portal tabs/toolbars here; the empty remainder stays draggable. */}
            {!auth && <div ref={setTitlebarSlot} data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-1" />}

            {!auth && (view === "session" || view === "terminal") && activeProjectId && (
                <Button variant="ghost" size="sm" className="mr-1 shrink-0 text-muted-foreground" aria-label="Back to project canvas" title="Project canvas" onClick={() => openCanvas(activeProjectId)}>
                    <IconTopologyStar3 />
                    Canvas
                </Button>
            )}

            {!auth && ((view === "session" || view === "terminal") || (view === "canvas" && !!canvasProjectId)) && (
                <Button data-right-sidebar-trigger="true" variant="ghost" size="icon-sm" className="mr-1 shrink-0 text-muted-foreground! transition-colors hover:text-foreground!" aria-label={rightSidebar.open ? "Hide project panel" : "Show project panel"} aria-pressed={rightSidebar.open} title="Project panel" onClick={toggleRightSidebar}>
                    <IconLayoutSidebarRight />
                </Button>
            )}

            <div className="flex h-full items-stretch">
                <TitlebarButton
                    label="Minimize"
                    onClick={() => void appWindow?.minimize()}
                >
                    <IconMinus size={14} stroke={1.5} />
                </TitlebarButton>
                <TitlebarButton
                    label={isMaximized ? "Restore" : "Maximize"}
                    onClick={() => void appWindow?.toggleMaximize()}
                >
                    {isMaximized ? (
                        <IconCopy size={12} stroke={1.5} />
                    ) : (
                        <IconSquare size={12} stroke={1.5} />
                    )}
                </TitlebarButton>
                <TitlebarButton
                    label="Close"
                    className="hover:bg-[#e81123] hover:text-white focus-visible:ring-white/50"
                    onClick={() => void appWindow?.close()}
                >
                    <IconX size={14} stroke={1.5} />
                </TitlebarButton>
            </div>
        </header>
    );
}
