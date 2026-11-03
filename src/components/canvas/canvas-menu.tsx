import {
  IconArrowsExchange, IconArrowsMaximize, IconCopy, IconEyeOff, IconFocus2, IconFocusCentered, IconLayoutDistributeHorizontal, IconLink, IconLinkOff,
  IconMap, IconMessages, IconPencil, IconPlayerPlay, IconPlus, IconSelectAll, IconSquareArrowUp, IconTerminal2, IconTextResize,
  IconTrash, IconZoomReset, IconChevronsDown, IconChevronsUp, IconActivity, IconRulerMeasure,
} from "@tabler/icons-react";
import {
  ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub,
  ContextMenuSubContent, ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { isLive } from "@/components/agents/provider";
import type { SessionSummary } from "@/lib/runtime/types";
import type { CanvasLink } from "./canvas-data";

export type MenuTarget =
  | { kind: "pane"; flow: { x: number; y: number } }
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string };

export type SizePreset = "small" | "medium" | "large" | "fit";

export interface MenuApi {
  sessionById: (id: string) => SessionSummary | undefined;
  linkById: (id: string) => CanvasLink | undefined;
  linksOf: (sessionId: string) => CanvasLink[];
  titleOf: (id: string) => string;
  collapsed: (id: string) => boolean;
  hasMirrorText: (id: string) => boolean;
  showMiniMap: boolean;
  showActivity: boolean;
  linkMode: boolean;
  newAgentHere: (flow: { x: number; y: number }) => void;
  toggleLinkMode: () => void;
  relayout: () => void;
  fit: () => void;
  selectAll: () => void;
  toggleMiniMap: () => void;
  toggleActivity: () => void;
  resetZoom: () => void;
  focus: (session: SessionSummary) => void;
  startLink: (id: string) => void;
  rename: (session: SessionSummary) => void;
  resume: (session: SessionSummary) => void;
  copyId: (id: string) => void;
  copyOutput: (id: string) => void;
  toggleCollapse: (id: string) => void;
  resize: (id: string, preset: SizePreset) => void;
  bringToFront: (id: string) => void;
  hide: (session: SessionSummary) => void;
  deleteLink: (link: CanvasLink) => void;
  reverseLink: (link: CanvasLink) => void;
  showWire: (link: CanvasLink) => void;
}

const danger = "text-destructive focus:text-destructive [&_svg]:text-destructive!";

export default function CanvasMenuContent({ target, api }: { target: MenuTarget; api: MenuApi }) {
  if (target.kind === "pane") return <PaneMenu flow={target.flow} api={api} />;
  if (target.kind === "node") {
    const session = api.sessionById(target.id);
    return session ? <NodeMenu session={session} api={api} /> : null;
  }
  const link = api.linkById(target.id);
  return link ? <EdgeMenu link={link} api={api} /> : null;
}

function PaneMenu({ flow, api }: { flow: { x: number; y: number }; api: MenuApi }) {
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem onSelect={() => api.newAgentHere(flow)}><IconPlus />New agent here</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem checked={api.linkMode} onSelect={api.toggleLinkMode}><IconLink />Link mode<ContextMenuShortcut>L</ContextMenuShortcut></ContextMenuCheckboxItem>
      <ContextMenuItem onSelect={api.relayout}><IconLayoutDistributeHorizontal />Re-layout</ContextMenuItem>
      <ContextMenuItem onSelect={api.selectAll}><IconSelectAll />Select all<ContextMenuShortcut>Ctrl A</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={api.fit}><IconArrowsMaximize />Fit view<ContextMenuShortcut>F</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem onSelect={api.resetZoom}><IconZoomReset />Reset zoom</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem checked={api.showMiniMap} onSelect={api.toggleMiniMap}><IconMap />Mini map</ContextMenuCheckboxItem>
      <ContextMenuCheckboxItem checked={api.showActivity} onSelect={api.toggleActivity}><IconActivity />Activity panel</ContextMenuCheckboxItem>
    </ContextMenuContent>
  );
}

function NodeMenu({ session, api }: { session: SessionSummary; api: MenuApi }) {
  const live = isLive(session.state);
  const links = api.linksOf(session.id).filter((link) => !link.synthetic);
  const collapsed = api.collapsed(session.id);
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuLabel className="truncate">{session.title}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => api.focus(session)}><IconTerminal2 />Open full terminal<ContextMenuShortcut>Dbl-click</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem onSelect={() => api.startLink(session.id)}><IconLink />Link to…</ContextMenuItem>
      <ContextMenuItem onSelect={() => api.rename(session)}><IconPencil />Rename</ContextMenuItem>
      <ContextMenuItem disabled={live} onSelect={() => api.resume(session)}>
        <IconPlayerPlay />{session.state === "sleeping" ? "Resume" : "Restart"}{live && <ContextMenuShortcut>Already running</ContextMenuShortcut>}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => api.copyId(session.id)}><IconCopy />Copy session id</ContextMenuItem>
      <ContextMenuItem disabled={!api.hasMirrorText(session.id)} onSelect={() => api.copyOutput(session.id)}>
        <IconCopy />Copy last output{!api.hasMirrorText(session.id) && <ContextMenuShortcut>Not live</ContextMenuShortcut>}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => api.toggleCollapse(session.id)}>
        {collapsed ? <IconChevronsDown /> : <IconChevronsUp />}{collapsed ? "Expand mirror" : "Collapse mirror"}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger><IconTextResize />Size</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          <ContextMenuItem onSelect={() => api.resize(session.id, "small")}><IconRulerMeasure />Small (360 x 220)</ContextMenuItem>
          <ContextMenuItem onSelect={() => api.resize(session.id, "medium")}><IconRulerMeasure />Medium (520 x 320)</ContextMenuItem>
          <ContextMenuItem onSelect={() => api.resize(session.id, "large")}><IconRulerMeasure />Large (860 x 540)</ContextMenuItem>
          <ContextMenuItem onSelect={() => api.resize(session.id, "fit")}><IconArrowsMaximize />Fit to content</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onSelect={() => api.bringToFront(session.id)}><IconSquareArrowUp />Bring to front</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={links.length === 0}><IconLinkOff />{links.length ? "Delete links" : "No links to delete"}</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-60">
          {links.map((link) => {
            const outgoing = link.fromSessionId === session.id;
            const other = api.titleOf(outgoing ? link.toSessionId : link.fromSessionId);
            return <ContextMenuItem key={link.id} className={danger} onSelect={() => api.deleteLink(link)}><IconLinkOff /><span className="truncate">{outgoing ? "to" : "from"} {other}</span></ContextMenuItem>;
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onSelect={() => api.hide(session)}><IconEyeOff />Close tab (hide from sidebar)</ContextMenuItem>
    </ContextMenuContent>
  );
}

function EdgeMenu({ link, api }: { link: CanvasLink; api: MenuApi }) {
  const from = api.sessionById(link.fromSessionId);
  const to = api.sessionById(link.toSessionId);
  const reason = link.synthetic ? "Inferred" : undefined;
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuLabel className="truncate">{api.titleOf(link.fromSessionId)} → {api.titleOf(link.toSessionId)}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => api.showWire(link)}><IconMessages />Show recent messages</ContextMenuItem>
      <ContextMenuItem disabled={!from} onSelect={() => from && api.focus(from)}><IconFocus2 />Focus from-agent</ContextMenuItem>
      <ContextMenuItem disabled={!to} onSelect={() => to && api.focus(to)}><IconFocusCentered />Focus to-agent</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={link.synthetic} onSelect={() => api.reverseLink(link)}><IconArrowsExchange />Reverse direction{reason && <ContextMenuShortcut>{reason}</ContextMenuShortcut>}</ContextMenuItem>
      <ContextMenuItem disabled={link.synthetic} className={danger} onSelect={() => api.deleteLink(link)}>
        <IconTrash />Delete link{reason ? <ContextMenuShortcut>{reason}</ContextMenuShortcut> : <ContextMenuShortcut>Del</ContextMenuShortcut>}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

