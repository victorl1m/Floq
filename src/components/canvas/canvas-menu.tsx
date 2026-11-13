import {
  IconArrowsExchange, IconArrowsMaximize, IconCopy, IconLayoutDistributeHorizontal, IconLink, IconLinkOff,
  IconMessages, IconPencil, IconPlayerPlay, IconPlus, IconSelectAll, IconSquareArrowUp, IconRefresh, IconWindowMaximize, IconTextResize,
  IconTrash, IconZoomReset, IconChevronsDown, IconChevronsUp, IconActivity, IconRulerMeasure, IconNote, IconCrown, IconCrownOff, IconWorld,
} from "@tabler/icons-react";
import {
  ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub,
  ContextMenuSubContent, ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Keys } from "./canvas-kbd";
import { isLive } from "@/components/agents/provider";
import { isOrchestrator } from "@/lib/runtime/orchestrator";
import type { SessionSummary } from "@/lib/runtime/types";
import type { CanvasLink } from "./canvas-data";
import { isNoteId, isNoteLinkId } from "./canvas-notes";
import { isBrowserId } from "./browser-node";

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
  showActivity: boolean;
  linkMode: boolean;
  newAgentHere: (flow: { x: number; y: number }) => void;
  addNoteHere: (flow: { x: number; y: number }) => void;
  openBrowser: (flow: { x: number; y: number }) => void;
  browserOpen: boolean;
  browserInfo: (nodeId: string) => { agents: Array<{ sessionId: string; title: string }> } | undefined;
  closeBrowser: (nodeId: string) => void;
  browsers: Array<{ id: string; linked: string[] }>;
  linkToBrowser: (sessionId: string, nodeId: string) => void;
  unlinkBrowserAgent: (nodeId: string, sessionId: string) => void;
  noteInfo: (nodeId: string) => { linked: number } | undefined;
  deleteNote: (nodeId: string) => void;
  unlinkNoteAgents: (nodeId: string) => void;
  noteEdge: (edgeId: string) => { agent: string } | undefined;
  unlinkNote: (edgeId: string) => void;
  nodeCount: number;
  deleteAgent: (session: SessionSummary) => void;
  setOrchestrator: (session: SessionSummary, on: boolean) => void;
  toggleLinkMode: () => void;
  relayout: () => void;
  fit: () => void;
  selectAll: () => void;
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
  deleteLink: (link: CanvasLink) => void;
  reverseLink: (link: CanvasLink) => void;
  showWire: (link: CanvasLink) => void;
}

const danger = "text-destructive focus:text-destructive [&_svg]:text-destructive!";

export default function CanvasMenuContent({ target, api }: { target: MenuTarget; api: MenuApi }) {
  if (target.kind === "pane") return <PaneMenu flow={target.flow} api={api} />;
  if (target.kind === "node" && isNoteId(target.id)) return <NoteMenu id={target.id} api={api} />;
  if (target.kind === "node" && isBrowserId(target.id)) return <BrowserMenu id={target.id} api={api} />;
  if (target.kind === "edge" && isNoteLinkId(target.id)) return <NoteLinkMenu id={target.id} api={api} />;
  if (target.kind === "node") {
    const session = api.sessionById(target.id);
    return session ? <NodeMenu session={session} api={api} /> : null;
  }
  const link = api.linkById(target.id);
  return link ? <EdgeMenu link={link} api={api} /> : null;
}

function PaneMenu({ flow, api }: { flow: { x: number; y: number }; api: MenuApi }) {
  const hasNodes = api.nodeCount > 0;
  return (
    <ContextMenuContent className="min-w-56">
      <ContextMenuItem onSelect={() => api.newAgentHere(flow)}><IconPlus />New agent here</ContextMenuItem>
      <ContextMenuItem onSelect={() => api.addNoteHere(flow)}><IconNote />Add note here<Keys keys="N" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => api.openBrowser(flow)}><IconWorld />New browser here</ContextMenuItem>
      {hasNodes && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={api.toggleLinkMode}><IconLink />{api.linkMode ? "Exit link mode" : "Link mode"}<Keys keys="L" /></ContextMenuItem>
          <ContextMenuItem onSelect={api.relayout}><IconLayoutDistributeHorizontal />Re-layout</ContextMenuItem>
          <ContextMenuItem onSelect={api.selectAll}><IconSelectAll />Select all<Keys keys="Ctrl A" /></ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={api.fit}><IconArrowsMaximize />Fit view<Keys keys="F" /></ContextMenuItem>
        </>
      )}
      <ContextMenuItem onSelect={api.resetZoom}><IconZoomReset />Reset zoom</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem checked={api.showActivity} onSelect={api.toggleActivity}><IconActivity />Activity panel</ContextMenuCheckboxItem>
    </ContextMenuContent>
  );
}

function NodeMenu({ session, api }: { session: SessionSummary; api: MenuApi }) {
  const live = isLive(session.state);
  const links = api.linksOf(session.id).filter((link) => !link.synthetic);
  const collapsed = api.collapsed(session.id);
  return (
    <ContextMenuContent className="min-w-60">
      <ContextMenuLabel className="truncate">{session.title}</ContextMenuLabel>
      {!live && <ContextMenuItem onSelect={() => api.resume(session)}>{session.state === "sleeping" ? <IconPlayerPlay /> : <IconRefresh />}{session.state === "sleeping" ? "Wake agent" : "Restart agent"}</ContextMenuItem>}
      <ContextMenuItem onSelect={() => api.focus(session)}><IconWindowMaximize />Open terminal<Keys keys="Dbl-click" /></ContextMenuItem>
      <ContextMenuItem onSelect={() => api.startLink(session.id)}><IconLink />Link to…</ContextMenuItem>
      {api.browsers.length > 0 && <ContextMenuSub>
        <ContextMenuSubTrigger><IconWorld />Link to browser</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-52">
          {api.browsers.map((browser, index) => <ContextMenuItem key={browser.id} onSelect={() => api.linkToBrowser(session.id, browser.id)}><IconWorld />Browser {index + 1}{browser.linked.includes(session.id) ? " (linked)" : ""}</ContextMenuItem>)}
        </ContextMenuSubContent>
      </ContextMenuSub>}
      <ContextMenuItem onSelect={() => api.rename(session)}><IconPencil />Rename</ContextMenuItem>
      {isOrchestrator(session)
        ? <ContextMenuItem onSelect={() => api.setOrchestrator(session, false)}><IconCrownOff />Remove orchestrator role</ContextMenuItem>
        : <ContextMenuItem title="Only the orchestrator can recruit agents; other agents must ask it." onSelect={() => api.setOrchestrator(session, true)}><IconCrown />Set as orchestrator</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => api.copyId(session.id)}><IconCopy />Copy session id</ContextMenuItem>
      {api.hasMirrorText(session.id) && <ContextMenuItem onSelect={() => api.copyOutput(session.id)}><IconCopy />Copy last output</ContextMenuItem>}
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
      {links.length > 0 && <ContextMenuSub>
        <ContextMenuSubTrigger><IconLinkOff />Delete links</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-60">
          {links.map((link) => {
            const outgoing = link.fromSessionId === session.id;
            const other = api.titleOf(outgoing ? link.toSessionId : link.fromSessionId);
            return <ContextMenuItem key={link.id} className={danger} onSelect={() => api.deleteLink(link)}><IconLinkOff /><span className="truncate">{outgoing ? "to" : "from"} {other}</span></ContextMenuItem>;
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>}
      <ContextMenuItem className={danger} title="Del deletes selected agents instantly, without confirmation" onSelect={() => api.deleteAgent(session)}><IconTrash />Delete agent<Keys keys="Del" /></ContextMenuItem>
    </ContextMenuContent>
  );
}

function EdgeMenu({ link, api }: { link: CanvasLink; api: MenuApi }) {
  const from = api.sessionById(link.fromSessionId);
  const to = api.sessionById(link.toSessionId);
  const real = !link.synthetic;
  return (
    <ContextMenuContent className="min-w-60">
      <ContextMenuLabel className="truncate">{api.titleOf(link.fromSessionId)} → {api.titleOf(link.toSessionId)}</ContextMenuLabel>
      {link.messageCount > 0 && <ContextMenuItem onSelect={() => api.showWire(link)}><IconMessages />Show recent messages</ContextMenuItem>}
      {from && <ContextMenuItem onSelect={() => api.focus(from)}><IconWindowMaximize />Open from-agent terminal</ContextMenuItem>}
      {to && <ContextMenuItem onSelect={() => api.focus(to)}><IconWindowMaximize />Open to-agent terminal</ContextMenuItem>}
      {real && (
        <>
          <ContextMenuSeparator />
          {!isBrowserId(link.toSessionId) && <ContextMenuItem onSelect={() => api.reverseLink(link)}><IconArrowsExchange />Reverse direction</ContextMenuItem>}
          <ContextMenuItem className={danger} onSelect={() => api.deleteLink(link)}><IconTrash />Delete link<Keys keys="Del" /></ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

function NoteMenu({ id, api }: { id: string; api: MenuApi }) {
  const info = api.noteInfo(id);
  if (!info) return null;
  return (
    <ContextMenuContent className="min-w-56">
      <ContextMenuLabel>Note</ContextMenuLabel>
      {info.linked > 0 && <><ContextMenuItem onSelect={() => api.unlinkNoteAgents(id)}><IconLinkOff />Unlink {info.linked === 1 ? "agent" : `${info.linked} agents`}</ContextMenuItem><ContextMenuSeparator /></>}
      <ContextMenuItem className={danger} onSelect={() => api.deleteNote(id)}><IconTrash />Delete note<Keys keys="Del" /></ContextMenuItem>
    </ContextMenuContent>
  );
}

function NoteLinkMenu({ id, api }: { id: string; api: MenuApi }) {
  const info = api.noteEdge(id);
  if (!info) return null;
  return (
    <ContextMenuContent className="min-w-56">
      <ContextMenuLabel className="truncate">Note → {info.agent}</ContextMenuLabel>
      <ContextMenuItem className={danger} onSelect={() => api.unlinkNote(id)}><IconLinkOff />Unlink<Keys keys="Del" /></ContextMenuItem>
    </ContextMenuContent>
  );
}

function BrowserMenu({ id, api }: { id: string; api: MenuApi }) {
  const info = api.browserInfo(id);
  if (!info) return null;
  return (
    <ContextMenuContent className="min-w-60">
      <ContextMenuLabel>Browser</ContextMenuLabel>
      <ContextMenuItem onSelect={() => api.startLink(id)}><IconLink />Link to agent…</ContextMenuItem>
      {info.agents.length > 0 && <ContextMenuSub>
        <ContextMenuSubTrigger><IconLinkOff />Unlink agent</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-60">
          {info.agents.map((agent) => <ContextMenuItem key={agent.sessionId} className={danger} onSelect={() => api.unlinkBrowserAgent(id, agent.sessionId)}><IconLinkOff /><span className="truncate">{agent.title}</span></ContextMenuItem>)}
        </ContextMenuSubContent>
      </ContextMenuSub>}
      <ContextMenuSeparator />
      <ContextMenuItem className={danger} onSelect={() => api.closeBrowser(id)}><IconTrash />Close browser</ContextMenuItem>
    </ContextMenuContent>
  );
}
