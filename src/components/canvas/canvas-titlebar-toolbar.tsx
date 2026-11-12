import { useLayoutEffect, useRef, useState } from "react";
import {
  IconActivity, IconArrowsMaximize, IconBrain, IconDots, IconGitCompare, IconHandStop, IconLayoutDistributeHorizontal, IconLink,
  IconNote, IconNotes, IconPlayerPlay, IconPointer,
} from "@tabler/icons-react";
import { ProjectMark } from "@/components/projects/project-identity";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatChangeCount } from "@/lib/changes-dialog";
import { ShortcutTip } from "./shortcut-tip";


type ToolbarProject = Parameters<typeof ProjectMark>[0]["project"];

export interface CanvasTitlebarToolbarProps {
  project: ToolbarProject;
  /** Stable key for the project mark (resets the image fallback when the project changes). */
  projectKey: string;
  name: string;
  cwd?: string;
  sleepingCount: number;
  onWakeAll: () => void;
  tool: "select" | "pan";
  onTool: (tool: "select" | "pan") => void;
  linkActive: boolean;
  onToggleLink: () => void;
  onAddNote: () => void;
  onRelayout: () => void;
  onShowNotes: () => void;
  /** Undefined hides the Memory button (memory is off on this runtime). */
  onOpenMemory?: () => void;
  onFit: () => void;
  onOpenChanges: () => void;
  /** Current branch of the ground workspace; null while unknown. */
  branch?: string | null;
  /** Uncommitted file count; null while unknown. */
  changeCount: number | null;
  activityOpen: boolean;
  onToggleActivity: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * The project canvas toolbar, rendered into the app titlebar slot. Presentational: all state and handlers come from AgentCanvas.
 * Width collapse is CSS-only (container queries in index.css): the tool groups fold into the "Canvas tools" menu,
 * and Wake all moves into that menu too. Wake all sits in the middle of the tools, in a rounded pill.
 */
export function CanvasTitlebarToolbar(p: CanvasTitlebarToolbarProps) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  // The toolbar is centred on the window, not on the leftover titlebar slot: measure where the slot sits and offset into it.
  // The identity stays on the left and its max width is whatever is left before the toolbar starts.
  const [pos, setPos] = useState<{ left: number | string; maxWidth: number | string; idMax: number | string }>({ left: "50%", maxWidth: "60%", idMax: "25%" });
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const center = centerRef.current;
    if (!layout || !center) return;
    const measure = () => {
      const l = layout.getBoundingClientRect();
      const cx = window.innerWidth / 2;
      const left = cx - l.left;
      const maxWidth = Math.max(0, Math.min(cx - l.left, l.right - cx) * 2);
      const width = Math.min(center.getBoundingClientRect().width, maxWidth);
      const idMax = Math.max(0, left - width / 2 - 12);
      setPos((prev) => (prev.left === left && prev.maxWidth === maxWidth && prev.idMax === idMax ? prev : { left, maxWidth, idMax }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(layout);
    ro.observe(center);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const wakeLabel = p.sleepingCount ? `Wake all sleeping agents (${p.sleepingCount})` : "No sleeping agents";
  const toolButton = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode, cursor?: "add-note") => (
    <Button type="button" data-cursor={cursor} variant={active ? "secondary" : "ghost"} size="icon-sm" aria-label={label} aria-pressed={active} onClick={onClick}>{icon}</Button>
  );
  const changeBadge = p.changeCount ? formatChangeCount(p.changeCount) : null;
  const branchName = p.branch || "No branch";
  const changesLabel = changeBadge ? `Changes on ${branchName} (${changeBadge})` : `Changes on ${branchName}`;
  const separator = <span aria-hidden data-tauri-drag-region className="mx-0.5 h-5 w-px shrink-0 bg-border/80" />;

  return (
    <div role="toolbar" aria-label="Canvas toolbar" data-tauri-drag-region className="canvas-titlebar-toolbar flex h-full min-w-0 flex-1 items-center" onKeyDown={p.onKeyDown}>
      <div ref={layoutRef} data-tauri-drag-region className="canvas-titlebar-layout relative flex h-full min-w-0 flex-1 items-center gap-1">
        <div
          data-tauri-drag-region
          title={p.cwd ? `${p.name} — ${p.cwd}` : p.name}
          className="canvas-titlebar-identity pointer-events-none flex h-full min-w-0 items-center gap-2"
          style={{ maxWidth: pos.idMax }}
        >
          <span aria-hidden data-tauri-drag-region className="flex size-[18px] shrink-0 items-center justify-center">
            <ProjectMark key={p.projectKey} project={p.project} className="pointer-events-none size-[18px] text-muted-foreground" />
          </span>
          <span aria-hidden data-tauri-drag-region className="canvas-titlebar-name min-w-0 truncate text-sm font-medium">{p.name}</span>
          {p.branch && <span aria-hidden data-tauri-drag-region className="canvas-titlebar-branch min-w-0 max-w-40 truncate text-xs text-muted-foreground">{p.branch}</span>}
          <span className="sr-only">{p.name}</span>
        </div>

        <div ref={centerRef} data-tauri-drag-region className="canvas-titlebar-center absolute top-0 flex h-full min-w-0 items-center gap-1" style={{ left: pos.left, maxWidth: pos.maxWidth }}>
        <ShortcutTip label={changeBadge ? `Changes (${changeBadge})` : "Changes"}>
          <Button type="button" variant="ghost" size="icon-sm" className="canvas-titlebar-changes relative shrink-0" aria-label={changesLabel} onClick={p.onOpenChanges}>
            <IconGitCompare size={16} />
            {changeBadge && <span className="absolute -top-1 -right-2 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-primary-foreground tabular-nums">{changeBadge}</span>}
          </Button>
        </ShortcutTip>

        <div data-tauri-drag-region role="group" aria-label="Canvas tools" className="canvas-titlebar-tools flex min-w-0 items-center gap-1">
          <div data-tauri-drag-region role="group" aria-label="Canvas modes" className="flex shrink-0 items-center gap-0.5">
            <ShortcutTip label="Select (drag to box-select)">{toolButton(p.tool === "select", "Select (drag to box-select)", () => p.onTool("select"), <IconPointer size={16} />)}</ShortcutTip>
            <ShortcutTip label="Pan (drag to move canvas)">{toolButton(p.tool === "pan", "Pan (drag to move canvas)", () => p.onTool("pan"), <IconHandStop size={16} />)}</ShortcutTip>
            <ShortcutTip label="Link mode" keys="L">{toolButton(p.linkActive, "Link mode (L)", p.onToggleLink, <IconLink size={16} />)}</ShortcutTip>
          </div>
          {separator}
          <div data-tauri-drag-region role="group" aria-label="Add to canvas" className="flex shrink-0 items-center gap-0.5">
            <ShortcutTip label="Add note" keys="N">{toolButton(false, "Add note (N)", p.onAddNote, <IconNote size={16} />, "add-note")}</ShortcutTip>
          </div>
          {separator}
          <div data-tauri-drag-region role="group" aria-label="Agents" className="flex shrink-0 items-center rounded-full border border-border/80 p-0.5">
            <ShortcutTip label={wakeLabel}>
              <span tabIndex={p.sleepingCount === 0 ? 0 : undefined} className="inline-flex">
                <Button type="button" variant="ghost" size="icon-sm" className="relative rounded-full" aria-label={wakeLabel} disabled={p.sleepingCount === 0} onClick={p.onWakeAll}>
                  <IconPlayerPlay size={16} />
                  {p.sleepingCount > 0 && <span className="absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-primary-foreground tabular-nums">{p.sleepingCount}</span>}
                </Button>
              </span>
            </ShortcutTip>
          </div>
          {separator}
          <div data-tauri-drag-region role="group" aria-label="Canvas view" className="flex shrink-0 items-center gap-0.5">
            <ShortcutTip label="Re-layout">{toolButton(false, "Re-layout", p.onRelayout, <IconLayoutDistributeHorizontal size={16} />)}</ShortcutTip>
            <ShortcutTip label="Show all notes">{toolButton(false, "Show all notes", p.onShowNotes, <IconNotes size={16} />)}</ShortcutTip>
            <ShortcutTip label="Fit view" keys="F">{toolButton(false, "Fit view (F)", p.onFit, <IconArrowsMaximize size={16} />)}</ShortcutTip>
            {p.onOpenMemory && <ShortcutTip label="Memory">{toolButton(false, "Memory", p.onOpenMemory, <IconBrain size={16} />)}</ShortcutTip>}
            <ShortcutTip label="Activity">{toolButton(p.activityOpen, "Activity", p.onToggleActivity, <IconActivity size={16} />)}</ShortcutTip>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Canvas tools" className="canvas-titlebar-overflow"><IconDots size={16} /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 whitespace-nowrap">
            <DropdownMenuRadioGroup value={p.tool} onValueChange={(value) => p.onTool(value === "pan" ? "pan" : "select")}>
              <DropdownMenuRadioItem value="select"><IconPointer size={16} />Select</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="pan"><IconHandStop size={16} />Pan</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuCheckboxItem checked={p.linkActive} onCheckedChange={p.onToggleLink}><IconLink size={16} />Link mode (L)</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={p.onAddNote}><IconNote size={16} />Add note (N)</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={p.sleepingCount === 0} onSelect={p.onWakeAll}><IconPlayerPlay size={16} />{wakeLabel}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={p.onRelayout}><IconLayoutDistributeHorizontal size={16} />Re-layout</DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onShowNotes}><IconNotes size={16} />Show all notes</DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onFit}><IconArrowsMaximize size={16} />Fit view (F)</DropdownMenuItem>
            {p.onOpenMemory && <DropdownMenuItem onSelect={p.onOpenMemory}><IconBrain size={16} />Memory</DropdownMenuItem>}
            <DropdownMenuCheckboxItem checked={p.activityOpen} onCheckedChange={p.onToggleActivity}><IconActivity size={16} />Activity</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>

      </div>
    </div>
  );
}
