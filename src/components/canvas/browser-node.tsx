// Browser canvas node: the user's shared agent browser (CDP screencast relayed by the runtime) with tabs, URL bar and input.
// Contract: docs/design/agent-browser.md §A.5 / §A.8. One node per canvas; open state and geometry are stored locally per project.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NodeResizer, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { IconUpload, IconArrowLeft, IconArrowRight, IconGripHorizontal, IconPlus, IconRefresh, IconWorld, IconX } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { BrowserImportDialog } from "@/components/canvas/browser-import-dialog";
import type { RuntimeClient } from "@/lib/runtime/client";
import { FRAME_QUALITY, MAX_FRAME, mapPointer, modifierBits, normalizeUrl, useBrowserStream } from "@/lib/runtime/browser-stream";

export const BROWSER_PREFIX = "browser:";
export const BROWSER_NODE_ID = BROWSER_PREFIX + "main";
export const isBrowserId = (id: string) => id.startsWith(BROWSER_PREFIX);
export const BROWSER_DEFAULT = { width: 900, height: 620 };
const ACTIVITY_MS = 4_000;
const POLL_MS = 5_000;

export type BrowserNode = Node<{ projectId: string }, "browser">;
interface BrowserCtxValue { client: RuntimeClient | null; openSettings?: () => void; close: () => void }
const BrowserCtx = createContext<BrowserCtxValue>({ client: null, close: () => {} });
export const BrowserProvider = BrowserCtx.Provider;

const btnName = (b: number) => (b === 1 ? "middle" : b === 2 ? "right" : "left") as "left" | "middle" | "right";
const tabLabel = (title: string, url: string) => title || url.replace(/^https?:\/\//, "") || "New tab";

const BrowserCard = memo(function BrowserCard({ selected }: NodeProps<BrowserNode>) {
  const { client, openSettings, close } = useContext(BrowserCtx);
  const stream = useBrowserStream(client, true);
  const { state, frame, tabs, nav, activity, agents, send, reconnect } = stream;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [urlText, setUrlText] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const viewRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastMove = useRef(0);

  // Active tab: keep the user's choice while it exists, else follow the stream's current frame, else the first tab.
  const current = tabs.find((t) => t.targetId === activeId) ?? tabs.find((t) => t.targetId === frame?.targetId) ?? tabs[0] ?? null;
  const targetId = current?.targetId ?? null;
  const info = targetId ? nav[targetId] : undefined;
  const agentBusy = !!targetId && now - (activity[targetId] ?? 0) < ACTIVITY_MS;
  useEffect(() => { if (!agentBusy && !Object.keys(activity).length) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [agentBusy, activity]);
  useEffect(() => { if (!urlFocused) setUrlText(info?.url ?? current?.url ?? ""); }, [info?.url, current?.url, urlFocused]);

  // Screencast runs only while the node is visible (on-screen and the document is not hidden).
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = viewRef.current; if (!el) return;
    let onScreen = true;
    const update = () => setVisible(onScreen && document.visibilityState !== "hidden");
    const io = new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1]?.isIntersecting ?? true; update(); });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, [state]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = viewRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [state]);
  const sizeKey = `${Math.round(size.w / 40)}x${Math.round(size.h / 40)}`; // restart only on meaningful resizes
  useEffect(() => {
    if (state !== "running" || !targetId || !visible || size.w < 50 || size.h < 50) { if (state === "running") send({ type: "screencast.stop" }); return; }
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const k = Math.min(1, MAX_FRAME.w / (size.w * dpr), MAX_FRAME.h / (size.h * dpr));
    send({ type: "screencast.start", targetId, maxW: Math.round(size.w * dpr * k), maxH: Math.round(size.h * dpr * k), quality: FRAME_QUALITY });
    return () => send({ type: "screencast.stop" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, targetId, visible, sizeKey, send]);

  const point = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current; if (!img || !frame) return null;
    const r = img.getBoundingClientRect();
    return mapPointer(e.clientX, e.clientY, r, frame);
  };
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const onPointer = (kind: "mousePressed" | "mouseReleased" | "mouseMoved") => (e: React.PointerEvent) => {
    if (kind === "mousePressed") focusInput(); // letterbox clicks still focus the page for typing
    const p = point(e); if (!p) return;
    if (kind === "mouseMoved") { const t = performance.now(); if (t - lastMove.current < 16) return; lastMove.current = t; }
    if (kind === "mousePressed") { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
    send({ type: "input.mouse", kind, x: p.x, y: p.y, button: kind === "mouseMoved" ? (e.buttons & 1 ? "left" : "none") : btnName(e.button), clickCount: kind === "mouseMoved" ? 0 : Math.max(1, e.detail), modifiers: modifierBits(e) });
  };
  useEffect(() => { // wheel needs a non-passive listener to stop the canvas from zooming
    const el = viewRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); const p = point(e); if (p) send({ type: "input.wheel", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY }); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const composing = useRef(false);
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keeps canvas shortcuts (L, N, F, Delete, Ctrl+A ...) from firing while the page has focus
    if (e.key === "Escape") { (e.target as HTMLElement).blur(); return; }
    if (composing.current || e.nativeEvent.isComposing) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.ctrlKey || e.metaKey) { if (e.key.toLowerCase() === "v") return; } // paste goes through onPaste
    if (printable) { e.preventDefault(); send({ type: "input.text", text: e.key }); return; }
    e.preventDefault();
    send({ type: "input.key", kind: "keyDown", key: e.key, code: e.code, modifiers: modifierBits(e) });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (composing.current || e.nativeEvent.isComposing) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    send({ type: "input.key", kind: "keyUp", key: e.key, code: e.code, modifiers: modifierBits(e) });
  };
  const onPaste = (e: React.ClipboardEvent) => { e.preventDefault(); e.stopPropagation(); const text = e.clipboardData.getData("text/plain"); if (text) send({ type: "input.text", text: text.slice(0, 4096) }); };

  const go = () => {
    const url = normalizeUrl(urlText);
    if (!url) return;
    if (targetId) send({ type: "nav.go", targetId, url }); else send({ type: "tab.new", url });
  };
  const live = state === "running";
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div data-testid="browser-node" data-state={state} className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <NodeResizer isVisible={selected} minWidth={420} minHeight={300} />
      <div className="browser-drag flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border/70 px-3 text-xs font-medium">
        <IconWorld size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Browser{agents > 0 ? ` · ${agents} agent${agents === 1 ? "" : "s"} connected` : ""}</span>
        <IconGripHorizontal size={14} className="text-muted-foreground" />
        {client && state !== "disabled" && state !== "unavailable" && (
          <button type="button" aria-label="Import cookies and data" title="Import cookies & data" className="nodrag rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setImportOpen(true)}><IconUpload size={14} /></button>
        )}
        <button type="button" aria-label="Close browser" title="Close (the browser keeps running until idle)" className="nodrag rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={close}><IconX size={14} /></button>
      </div>
      <div className="nodrag nowheel nopan flex min-h-0 flex-1 flex-col">
        {live && (
          <>
            <div role="tablist" aria-label="Browser tabs" className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 bg-muted/30 px-1.5">
              {tabs.map((tab) => (
                <div key={tab.targetId} role="tab" aria-selected={tab.targetId === targetId} data-testid="browser-tab"
                  className={cn("group flex h-6 max-w-44 shrink-0 items-center gap-1 rounded-md px-2 text-xs", tab.targetId === targetId ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60")}
                  onClick={() => { setActiveId(tab.targetId); send({ type: "tab.select", targetId: tab.targetId }); }}>
                  {tab.opener === "agent" && <span className="rounded bg-primary/15 px-1 text-[9px] font-semibold uppercase text-primary">agent</span>}
                  <span className="truncate">{tabLabel(tab.title, tab.url)}</span>
                  <button type="button" aria-label={`Close tab ${tabLabel(tab.title, tab.url)}`} className="rounded opacity-0 hover:text-foreground group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); send({ type: "tab.close", targetId: tab.targetId }); }}><IconX size={11} /></button>
                </div>
              ))}
              <button type="button" aria-label="New tab" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => send({ type: "tab.new" })}><IconPlus size={13} /></button>
            </div>
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
              <button type="button" aria-label="Back" disabled={!info?.canBack} className="rounded p-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40" onClick={() => send({ type: "nav.back" })}><IconArrowLeft size={15} /></button>
              <button type="button" aria-label="Forward" disabled={!info?.canForward} className="rounded p-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40" onClick={() => send({ type: "nav.forward" })}><IconArrowRight size={15} /></button>
              {info?.loading
                ? <button type="button" aria-label="Stop" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => send({ type: "nav.stop" })}><IconX size={15} /></button>
                : <button type="button" aria-label="Reload" className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => send({ type: "nav.reload" })}><IconRefresh size={15} /></button>}
              <input aria-label="Address" spellCheck={false} value={urlText} placeholder="Search or enter address"
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                onFocus={(e) => { setUrlFocused(true); e.currentTarget.select(); }} onBlur={() => setUrlFocused(false)}
                onChange={(e) => setUrlText(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); } else if (e.key === "Escape") { setUrlText(info?.url ?? ""); e.currentTarget.blur(); } }} />
              {agentBusy && <span data-testid="browser-agent-pulse" className="flex shrink-0 items-center gap-1 pr-1 text-[10px] font-medium text-primary"><span className="size-1.5 animate-pulse rounded-full bg-primary" />Agent is using this tab</span>}
            </div>
          </>
        )}
        <div ref={viewRef} className="relative min-h-0 flex-1 bg-black/90">
          {live ? (
            <>
              {frame && <img ref={imgRef} data-testid="browser-frame" alt="Browser page" draggable={false} src={`data:image/jpeg;base64,${frame.jpeg}`}
                className="absolute inset-0 h-full w-full select-none object-contain touch-none"
                onMouseDown={(e) => { e.preventDefault(); focusInput(); }} onPointerDown={onPointer("mousePressed")} onPointerUp={onPointer("mouseReleased")} onPointerMove={onPointer("mouseMoved")}
                onContextMenu={(e) => e.preventDefault()} />}
              <textarea ref={inputRef} data-testid="browser-input" aria-label="Browser keyboard input" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0"
                onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPaste={onPaste}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={(e) => { composing.current = false; const text = e.data; e.currentTarget.value = ""; if (text) send({ type: "input.text", text: text.slice(0, 4096) }); }} />
              {!frame && <Overlay title="Loading page…" />}
            </>
          ) : state === "disabled" ? (
            <Overlay title="Browser is turned off" body="Agents cannot use it while it is off.">
              {openSettings && <Button size="sm" variant="outline" onClick={openSettings}>Open Settings</Button>}
            </Overlay>
          ) : state === "unavailable" ? (
            <Overlay title="Browser unavailable" body="This server's image has no browser installed." />
          ) : state === "stopped" ? (
            <Overlay title="Browser stopped" body="It stops when idle or after a crash."><Button size="sm" onClick={reconnect}>Restart</Button></Overlay>
          ) : (
            <Overlay title={state === "starting" ? "Starting browser…" : "Connecting…"} />
          )}
        </div>
      </div>
      {client && <BrowserImportDialog client={client} open={importOpen} onOpenChange={setImportOpen} />}
    </div>
  );
});

function Overlay({ title, body, children }: { title: string; body?: string; children?: React.ReactNode }) {
  return (
    <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white/80">
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="max-w-xs text-xs text-white/60">{body}</p>}
      {children}
    </div>
  );
}
export const browserNodeTypes = { browser: BrowserCard };

// --- per-project local state (open flag + geometry), like app windows ---
const key = (projectId: string) => `floq:browser-node:${projectId}`;
interface Stored { open: boolean; seen?: boolean; x?: number; y?: number; width?: number; height?: number }
const read = (projectId: string): Stored => { try { return { open: false, ...JSON.parse(localStorage.getItem(key(projectId)) ?? "{}") }; } catch { return { open: false }; } };
const write = (projectId: string, value: Stored) => { try { localStorage.setItem(key(projectId), JSON.stringify(value)); } catch { /* storage unavailable */ } };

/**
 * The single Browser node of a canvas. Opened from the canvas menu, or automatically the first time an agent is connected
 * (polled while closed; once per project, the user closing it is remembered).
 */
export function useCanvasBrowser(client: RuntimeClient | null, projectId: string | null, anchor: { x: number; y: number }, autoOpenPoll = true) {
  const [stored, setStored] = useState<Stored>(() => (projectId ? read(projectId) : { open: false }));
  useEffect(() => { setStored(projectId ? read(projectId) : { open: false }); }, [projectId]);
  const [selected, setSelected] = useState(false);
  const update = useCallback((patch: Partial<Stored>) => {
    setStored((prev) => { const next = { ...prev, ...patch }; if (projectId) write(projectId, next); return next; });
  }, [projectId]);
  const open = useCallback((at?: { x: number; y: number }) => update({ open: true, seen: true, ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}) }), [update]);
  const close = useCallback(() => update({ open: false, seen: true }), [update]);

  useEffect(() => {
    if (!client || !projectId || stored.open || stored.seen || !autoOpenPoll) return;
    let stopped = false;
    const poll = async () => { try { const s = await client.browserStatus(); if (!stopped && (s.agents ?? 0) > 0) open(); } catch { /* older runtime / disabled */ } };
    void poll();
    const t = setInterval(() => { if (document.visibilityState !== "hidden") void poll(); }, POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [client, projectId, stored.open, stored.seen, autoOpenPoll, open]);

  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  const nodes = useMemo<BrowserNode[]>(() => (!projectId || !stored.open ? [] : [{
    id: BROWSER_NODE_ID, type: "browser", dragHandle: ".browser-drag", selected,
    position: { x: stored.x ?? anchorRef.current.x, y: stored.y ?? anchorRef.current.y },
    width: stored.width ?? BROWSER_DEFAULT.width, height: stored.height ?? BROWSER_DEFAULT.height,
    data: { projectId },
  }]), [projectId, stored, selected]);

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    const patch: Partial<Stored> = {};
    for (const c of changes) {
      if (!("id" in c) || c.id !== BROWSER_NODE_ID) continue;
      if (c.type === "select") setSelected(c.selected);
      else if (c.type === "position" && c.position) { patch.x = c.position.x; patch.y = c.position.y; }
      else if (c.type === "dimensions" && c.dimensions && c.setAttributes) { patch.width = c.dimensions.width; patch.height = c.dimensions.height; }
    }
    if (Object.keys(patch).length) update(patch);
  }, [update]);
  return { nodes, onNodesChange, isOpen: stored.open, open, close };
}
