import {
  IconActivity, IconArrowsMaximize, IconDots, IconHandStop, IconKey, IconLayoutDistributeHorizontal, IconLink,
  IconNote, IconNotes, IconPlayerPlay, IconPlus, IconPointer,
} from "@tabler/icons-react";
import { ProjectMark } from "@/components/projects/project-identity";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShortcutTip } from "./shortcut-tip";
import VaultPopover from "./vault-popover";

type ToolbarProject = Parameters<typeof ProjectMark>[0]["project"];

export interface CanvasTitlebarToolbarProps {
  project: ToolbarProject;
  /** Stable key for the project mark (resets the image fallback when the project changes). */
  projectKey: string;
  name: string;
  cwd?: string;
  sleepingCount: number;
  onWakeAll: () => void;
  canCreate: boolean;
  onNewAgent: () => void;
  tool: "select" | "pan";
  onTool: (tool: "select" | "pan") => void;
  linkActive: boolean;
  onToggleLink: () => void;
  onAddNote: () => void;
  onAddKeychain: () => void;
  onRelayout: () => void;
  onShowNotes: () => void;
  onFit: () => void;
  activityOpen: boolean;
  onToggleActivity: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * The project canvas toolbar, rendered into the app titlebar slot. Presentational: all state and handlers come from AgentCanvas.
 * Width collapse is CSS-only (container queries in index.css): name hides, then the tool groups fold into the "Canvas tools" menu,
 * then the New agent label hides. Vault and New agent always stay visible.
 */
export function CanvasTitlebarToolbar(p: CanvasTitlebarToolbarProps) {
  const wakeLabel = p.sleepingCount ? `Wake all sleeping agents (${p.sleepingCount})` : "No sleeping agents";
  const toolButton = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode, cursor?: "add-note" | "add-keychain") => (
    <Button type="button" data-cursor={cursor} variant={active ? "secondary" : "ghost"} size="icon-sm" aria-label={label} aria-pressed={active} onClick={onClick}>{icon}</Button>
  );
  const separator = <span aria-hidden data-tauri-drag-region className="mx-0.5 h-5 w-px shrink-0 bg-border/80" />;

  return (
    <div role="toolbar" aria-label="Canvas toolbar" data-tauri-drag-region className="canvas-titlebar-toolbar flex h-full min-w-0 flex-1 items-center gap-1" onKeyDown={p.onKeyDown}>
      <div data-tauri-drag-region title={p.cwd ? `${p.name} — ${p.cwd}` : p.name} className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        <span aria-hidden data-tauri-drag-region className="flex size-[18px] shrink-0 items-center justify-center">
          <ProjectMark key={p.projectKey} project={p.project} className="pointer-events-none size-[18px] text-muted-foreground" />
        </span>
        <span aria-hidden data-tauri-drag-region className="canvas-titlebar-name min-w-0 truncate text-sm font-medium">{p.name}</span>
        <span className="sr-only">{p.name}</span>
      </div>

      <div data-tauri-drag-region role="group" aria-label="Canvas tools" className="canvas-titlebar-tools flex min-w-0 items-center gap-1">
        <div data-tauri-drag-region role="group" aria-label="Canvas modes" className="flex shrink-0 items-center gap-0.5">
          <ShortcutTip label="Select (drag to box-select)">{toolButton(p.tool === "select", "Select (drag to box-select)", () => p.onTool("select"), <IconPointer size={16} />)}</ShortcutTip>
          <ShortcutTip label="Pan (drag to move canvas)">{toolButton(p.tool === "pan", "Pan (drag to move canvas)", () => p.onTool("pan"), <IconHandStop size={16} />)}</ShortcutTip>
          <ShortcutTip label="Link mode" keys="L">{toolButton(p.linkActive, "Link mode (L)", p.onToggleLink, <IconLink size={16} />)}</ShortcutTip>
        </div>
        {separator}
        <div data-tauri-drag-region role="group" aria-label="Add to canvas" className="flex shrink-0 items-center gap-0.5">
          <ShortcutTip label="Add note" keys="N">{toolButton(false, "Add note (N)", p.onAddNote, <IconNote size={16} />, "add-note")}</ShortcutTip>
          <ShortcutTip label="Add keychain" keys="K">{toolButton(false, "Add keychain (K)", p.onAddKeychain, <IconKey size={16} />, "add-keychain")}</ShortcutTip>
        </div>
        {separator}
        <div data-tauri-drag-region role="group" aria-label="Canvas view" className="flex shrink-0 items-center gap-0.5">
          <ShortcutTip label="Re-layout">{toolButton(false, "Re-layout", p.onRelayout, <IconLayoutDistributeHorizontal size={16} />)}</ShortcutTip>
          <ShortcutTip label="Show all notes">{toolButton(false, "Show all notes", p.onShowNotes, <IconNotes size={16} />)}</ShortcutTip>
          <ShortcutTip label="Fit view" keys="F">{toolButton(false, "Fit view (F)", p.onFit, <IconArrowsMaximize size={16} />)}</ShortcutTip>
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
          <DropdownMenuItem onSelect={p.onAddKeychain}><IconKey size={16} />Add keychain (K)</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={p.onRelayout}><IconLayoutDistributeHorizontal size={16} />Re-layout</DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onShowNotes}><IconNotes size={16} />Show all notes</DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onFit}><IconArrowsMaximize size={16} />Fit view (F)</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={p.activityOpen} onCheckedChange={p.onToggleActivity}><IconActivity size={16} />Activity</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div data-tauri-drag-region className="flex shrink-0 items-center gap-1">
        <ShortcutTip label={wakeLabel}>
          <span tabIndex={p.sleepingCount === 0 ? 0 : undefined} className="inline-flex">
            <Button type="button" variant="ghost" size="icon-sm" className="relative" aria-label={wakeLabel} disabled={p.sleepingCount === 0} onClick={p.onWakeAll}>
              <IconPlayerPlay size={16} />
              {p.sleepingCount > 0 && <span className="absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-primary-foreground tabular-nums">{p.sleepingCount}</span>}
            </Button>
          </span>
        </ShortcutTip>
        <VaultPopover size="sm" />
        <Button type="button" size="sm" className="shrink-0" aria-label="New agent" disabled={!p.canCreate} onClick={p.onNewAgent}>
          <IconPlus size={15} />
          <span className="canvas-titlebar-new-label">New agent</span>
        </Button>
      </div>
    </div>
  );
}
