// Browser canvas node: one page of the user's shared agent browser (CDP screencast relayed by the runtime) with URL bar and input.
// Contract: docs/design/agent-browser.md §A.5 / §A.8. Many nodes per canvas, one page each; geometry is stored locally per project.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { IconUpload, IconArrowLeft, IconArrowRight, IconGripHorizontal, IconPlus, IconRefresh, IconShieldCheck, IconWorld, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { CanvasCtx } from "@/components/canvas/canvas-context";
import { BrowserImportDialog } from "@/components/canvas/browser-import-dialog";
import { RESIZER_ABOVE, SIDE_STRIP_CLASS, SIDE_STRIP_STYLE } from "@/components/canvas/wire-edge";
import { MAX_SIZE, MIN_SIZE } from "@/components/canvas/agent-node";
import { robotAvatarSvg } from "@/lib/robot-avatar";
import { egressBadge } from "@/lib/browser-egress";
import type { RuntimeClient } from "@/lib/runtime/client";
import { FRAME_QUALITY, MAX_FRAME, buttonName, createClickCounter, looksLikeChallenge, mapPointer, mapPointerClamped, modifierBits, normalizeUrl, useBrowserStream, wheelPixels, type BrowserStreamState } from "@/lib/runtime/browser-stream";

export const BROWSER_PREFIX = "browser:";
export const BROWSER_NODE_ID = BROWSER_PREFIX + "main";
export const isBrowserId = (id: string) => id.startsWith(BROWSER_PREFIX);
export const BROWSER_DEFAULT = { width: 900, height: 620 };
const CHALLENGE_STALL_MS = 15_000;
const ACTIVITY_MS = 4_000;
const POLL_MS = 5_000;
const MOVE_MIN_MS = 16;
const MAX_AVATARS = 3;
const VIEWPORT_DEBOUNCE_MS = 250;
const SIDES = [
  { id: "top", position: Position.Top }, { id: "right", position: Position.Right },
  { id: "bottom", position: Position.Bottom }, { id: "left", position: Position.Left },
] as const;

export type BrowserNode = Node<{ projectId: string; nodeId: string }, "browser">;
export interface BrowserLinkedAgent { sessionId: string; title: string }
interface BrowserCtxValue {
  client: RuntimeClient | null;
  openSettings?: () => void;
  /** Closes a node (id incl. the `browser:` prefix). */
  close: (nodeId: string) => void;
  linkedAgents: (nodeId: string) => BrowserLinkedAgent[];
  newBrowser: () => void;
}
const BrowserCtx = createContext<BrowserCtxValue>({ client: null, close: () => {}, linkedAgents: () => [], newBrowser: () => {} });
export const BrowserProvider = BrowserCtx.Provider;

/**
 * Input and canvas interplay (final behaviour):
 * - Shift+click over the page reaches the page: the page carries `nokey`, so react-flow's Shift selection overlay ignores it.
 * - Canvas Link mode: the page ignores pointer input (the click links the node instead).
 * - Pointer: hover/drag/press/release/wheel over the page go to the page only. Presses capture the pointer, so drags and the
 *   final release work outside the image (coordinates are clamped into the page). Wheel never zooms or pans the canvas.
 * - Panning the canvas over a browser: drag the header (`.browser-drag`), or hold Space while the pointer is over the node and the
 *   page's hidden textarea is NOT focused. Then the live view stops capturing pointer events and the body drops `nopan`, so
 *   react-flow's own Space+drag pan takes the drag. Space typed into a focused page still goes to the page.
 * - Keyboard: only the focused textarea feeds the page, and it stops propagation so canvas shortcuts (L, N, F, Delete...) never fire.
 */
const BrowserCard = memo(function BrowserCard({ id, selected }: NodeProps<BrowserNode>) {
  const { client, openSettings, close, linkedAgents, newBrowser } = useContext(BrowserCtx);
  const nodeId = id.startsWith(BROWSER_PREFIX) ? id.slice(BROWSER_PREFIX.length) : id;
  const stream = useBrowserStream(client, true, nodeId);
  const { state, frame, targetId, nav: info, activity, cursor, send, reconnect, dialog, clipboard, download, egress } = stream;
  // Ctrl/Cmd+C in the page: the daemon reports the selected text and it lands on the user's own clipboard.
  useEffect(() => { if (clipboard) void navigator.clipboard?.writeText(clipboard.text).catch(() => {}); }, [clipboard]);
  const linked = linkedAgents(id);
  // Canvas Link mode: the page gets no pointer input at all, the click only links (it bubbles to the node).
  const linking = useContext(CanvasCtx)?.linkMode != null;
  const [urlText, setUrlText] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastMove = useRef(0);
  const clickCounter = useRef(createClickCounter());
  const held = useRef<{ clickCount: number; x: number; y: number; button: number } | null>(null);

  const agentBusy = !!targetId && now - activity < ACTIVITY_MS;
  useEffect(() => { if (!agentBusy && !activity) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [agentBusy, activity]);
  useEffect(() => { if (!urlFocused) setUrlText(info?.url ?? ""); }, [info?.url, urlFocused]);
  const challenge = looksLikeChallenge(info?.title, info?.url);
  // A challenge that is still up after CHALLENGE_STALL_MS has no interactive widget to complete: the site is refusing this browser.
  const [challengeStalled, setChallengeStalled] = useState(false);
  useEffect(() => {
    setChallengeStalled(false);
    if (!challenge) return;
    const t = setTimeout(() => setChallengeStalled(true), CHALLENGE_STALL_MS);
    return () => clearTimeout(t);
  }, [challenge, info?.url]);

  // Space-to-pan (see the comment above BrowserCard).
  const [spacePan, setSpacePan] = useState(false);
  const hovering = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && hovering.current && document.activeElement !== inputRef.current && !(e.target instanceof HTMLInputElement)) setSpacePan(true); };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpacePan(false); };
    const off = () => setSpacePan(false);
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", off);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", off); };
  }, []);

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
  // The page viewport follows the live view area (CSS px), debounced after mount/resize.
  useEffect(() => {
    if (state !== "running" || !targetId || size.w < 50 || size.h < 50) return;
    const t = setTimeout(() => {
      const c = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
      send({ type: "viewport", width: c(size.w, 200, 3840), height: c(size.h, 200, 2160), dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1 });
    }, VIEWPORT_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, targetId, size.w, size.h, send]);
  useEffect(() => {
    if (state !== "running" || !targetId || !visible || size.w < 50 || size.h < 50) { if (state === "running") send({ type: "screencast.stop" }); return; }
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const k = Math.min(1, MAX_FRAME.w / (size.w * dpr), MAX_FRAME.h / (size.h * dpr));
    send({ type: "screencast.start", maxW: Math.round(size.w * dpr * k), maxH: Math.round(size.h * dpr * k), quality: FRAME_QUALITY });
    return () => send({ type: "screencast.stop" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, targetId, visible, sizeKey, send]);

  const point = (e: { clientX: number; clientY: number }, clamp: boolean) => {
    const img = imgRef.current; if (!img || !frame) return null;
    return (clamp ? mapPointerClamped : mapPointer)(e.clientX, e.clientY, img.getBoundingClientRect(), frame);
  };
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const buttonsFor = (b: number) => (b & 1 ? "left" : b & 4 ? "middle" : b & 2 ? "right" : "none") as "left" | "middle" | "right" | "none";
  const onPointerDown = (e: React.PointerEvent) => {
    if (linking) return;
    focusInput(); // letterbox clicks still focus the page for typing
    const p = point(e, false); if (!p) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    // pointerdown.detail is 0 in Chrome: count clicks ourselves.
    const clickCount = clickCounter.current(performance.now(), p.x, p.y, e.button);
    held.current = { clickCount, x: p.x, y: p.y, button: e.button };
    send({ type: "input.mouse", kind: "mousePressed", x: p.x, y: p.y, button: buttonName(e.button), buttons: e.buttons, clickCount, modifiers: modifierBits(e) });
  };
  const release = (e: React.PointerEvent) => {
    if (linking) return;
    const h = held.current; if (!h) return;
    const p = point(e, true) ?? h;
    held.current = null;
    send({ type: "input.mouse", kind: "mouseReleased", x: p.x, y: p.y, button: buttonName(h.button), buttons: e.buttons, clickCount: h.clickCount, modifiers: modifierBits(e) });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (linking) return;
    const t = performance.now(); if (t - lastMove.current < MOVE_MIN_MS) return;
    const p = point(e, !!held.current || (e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)); if (!p) return;
    lastMove.current = t;
    send({ type: "input.mouse", kind: "mouseMoved", x: p.x, y: p.y, button: buttonsFor(e.buttons), buttons: e.buttons, clickCount: 0, modifiers: modifierBits(e) });
  };
  useEffect(() => { // wheel needs a non-passive listener to stop the canvas from zooming or panning
    const el = viewRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      const p = point(e, false); if (!p || !frame) return;
      send({ type: "input.wheel", x: p.x, y: p.y, dx: wheelPixels(e.deltaX, e.deltaMode, frame.h), dy: wheelPixels(e.deltaY, e.deltaMode, frame.h), modifiers: modifierBits(e) });
    };
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
  const onKeyPress = (e: React.KeyboardEvent) => e.stopPropagation();
  const onPaste = (e: React.ClipboardEvent) => { e.preventDefault(); e.stopPropagation(); const text = e.clipboardData.getData("text/plain"); if (text) send({ type: "input.text", text: text.slice(0, 4096) }); };

  const go = () => { const url = normalizeUrl(urlText); if (url) send({ type: "nav.go", url }); };
  const closeNode = () => { send({ type: "page.close" }); close(id); }; // only the user closing the node destroys the page
  const live = state === "running";
  const badge = egressBadge(egress);
  const [switching, setSwitching] = useState(false);
  // Fail closed: the daemon answers every connection with "offline" while this shows, nothing leaves via the server.
  const useServerNow = () => {
    if (!client || switching) return;
    setSwitching(true);
    // Transient (never saved): the user's desktop choice survives and the relay keeps running for when the computer is back.
    void client.browserEgressOverride(true)
      .catch(() => undefined)
      .finally(() => setSwitching(false));
  };
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="canvas-node-wrap group/node relative size-full" data-selected={selected ? "true" : undefined}>
      <NodeResizer lineStyle={RESIZER_ABOVE} handleStyle={RESIZER_ABOVE} isVisible={selected} minWidth={MIN_SIZE.width} minHeight={MIN_SIZE.height} maxWidth={MAX_SIZE.width} maxHeight={MAX_SIZE.height}
        lineClassName="border-primary/70!" handleClassName="size-2.5! rounded-sm! border-primary! bg-background!" />
      {SIDES.map((side) => (
        <Handle key={side.id} id={side.id} type="source" position={side.position} style={SIDE_STRIP_STYLE[side.position]} isConnectable isConnectableStart isConnectableEnd className={SIDE_STRIP_CLASS} />
      ))}
    <div ref={rootRef} data-testid="browser-node" data-state={state} data-node-id={id} className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      onPointerEnter={() => { hovering.current = true; }} onPointerLeave={() => { hovering.current = false; }}>
      <div className="browser-drag flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border/70 px-3 text-xs font-medium">
        <IconWorld size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">Browser</span>
        {linked.length > 0 && (
          <span className="flex shrink-0 items-center -space-x-1">
            {linked.slice(0, MAX_AVATARS).map((a) => (
              <span key={a.sessionId} data-testid="browser-linked-agent" title={a.title} className="inline-block size-4 shrink-0 overflow-hidden rounded-full ring-1 ring-card"
                dangerouslySetInnerHTML={{ __html: robotAvatarSvg(a.sessionId, false) }} />
            ))}
            {linked.length > MAX_AVATARS && <span className="pl-1.5 text-[10px] text-muted-foreground">+{linked.length - MAX_AVATARS}</span>}
          </span>
        )}
        {badge && (
          <span data-testid="browser-egress-badge" data-tone={badge.tone} title={badge.title}
            className={"flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium " + (badge.tone === "green" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : badge.tone === "amber" ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground")}>
            <span className={"size-1.5 rounded-full " + (badge.tone === "green" ? "bg-emerald-500" : badge.tone === "amber" ? "bg-amber-500" : "bg-muted-foreground/60")} />
            {badge.label}
          </span>
        )}
        <span className="flex-1" />
        <IconGripHorizontal size={14} className="text-muted-foreground" />
        <button type="button" aria-label="New browser" title="New browser" className="nodrag rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={newBrowser}><IconPlus size={14} /></button>
        {client && state !== "disabled" && state !== "unavailable" && (
          <button type="button" aria-label="Import cookies and data" title="Import cookies & data" className="nodrag rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setImportOpen(true)}><IconUpload size={14} /></button>
        )}
        <button type="button" aria-label="Close browser" title="Close this browser" className="nodrag rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={closeNode}><IconX size={14} /></button>
      </div>
      <div className={"nodrag nowheel flex min-h-0 flex-1 flex-col" + (spacePan ? "" : " nopan")}>
        {live && (
          <>
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
              {agentBusy && <span data-testid="browser-agent-pulse" className="flex shrink-0 items-center gap-1 pr-1 text-[10px] font-medium text-primary"><span className="size-1.5 animate-pulse rounded-full bg-primary" />Agent is using this page</span>}
            </div>
            {download && (
              <div role="status" data-testid="browser-download" className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate">{download.state === "started" ? `Downloading ${download.name}…` : download.state === "done" ? `Downloaded ${download.name}` : `Download of ${download.name} failed`}</span>
              </div>
            )}
            {challenge && (
              <div role="status" data-testid="browser-challenge-hint" className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                <IconShieldCheck size={12} className="shrink-0" />
                <span className="min-w-0">{challengeStalled
                  ? "This site is blocking automated browsers. Open it in your own browser, or use the site's API or a connector."
                  : "Verification needed. Complete it here, your clearance is kept for later agent use."}</span>
              </div>
            )}
          </>
        )}
        <div ref={viewRef} className="nokey relative min-h-0 flex-1 bg-black/90">
          {live ? (
            <>
              {frame && <img ref={imgRef} data-testid="browser-frame" alt="Browser page" draggable={false} src={`data:image/jpeg;base64,${frame.jpeg}`}
                className="nokey absolute inset-0 h-full w-full select-none object-contain touch-none" style={{ cursor: linking ? "pointer" : cursor, pointerEvents: spacePan || linking ? "none" : undefined }}
                onMouseDown={(e) => { e.preventDefault(); focusInput(); }} onPointerDown={onPointerDown} onPointerUp={release} onPointerCancel={release} onPointerMove={onPointerMove}
                onContextMenu={(e) => e.preventDefault()} />}
              <textarea ref={inputRef} data-testid="browser-input" aria-label="Browser keyboard input" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0"
                onKeyDown={onKeyDown} onKeyUp={onKeyUp} onKeyPress={onKeyPress} onPaste={onPaste}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={(e) => { composing.current = false; const text = e.data; e.currentTarget.value = ""; if (text) send({ type: "input.text", text: text.slice(0, 4096) }); }} />
              {!frame && <Overlay title="Loading page…" />}
              {badge?.paused && (
                <div data-testid="browser-egress-paused" className="absolute inset-0 z-10 bg-black/80">
                  <Overlay title="Paused" body="The browser uses your computer's connection and Floq isn't open there. Open Floq on your computer, or switch to the server connection.">
                    <div className="flex gap-2">
                      <Button size="sm" disabled={switching} onClick={useServerNow}>Use server connection this time</Button>
                      {openSettings && <Button size="sm" variant="outline" onClick={() => openSettings()}>Settings</Button>}
                    </div>
                  </Overlay>
                </div>
              )}
              {dialog && <PageDialog key={dialog.message + dialog.kind} dialog={dialog} onReply={(accept, text) => { send({ type: "dialog.reply", accept, ...(text !== undefined ? { text } : {}) }); }} />}
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
    </div>
  );
});

/** The page's alert/confirm/prompt: the page is blocked until it is answered. */
function PageDialog({ dialog, onReply }: { dialog: NonNullable<BrowserStreamState["dialog"]>; onReply: (accept: boolean, text?: string) => void }) {
  const [text, setText] = useState(dialog.defaultPrompt);
  const submit = () => onReply(true, dialog.kind === "prompt" ? text : undefined);
  return (
    <div role="alertdialog" aria-label="Page dialog" data-testid="browser-dialog" className="absolute inset-0 z-10 flex items-start justify-center bg-black/40 p-4"
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onReply(false); }}>
      <div className="mt-6 w-full max-w-sm rounded-lg border border-border bg-card p-3 text-card-foreground shadow-xl">
        <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{dialog.message || " "}</p>
        {dialog.kind === "prompt" && (
          <input autoFocus aria-label="Prompt answer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            className="mt-2 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/70" />
        )}
        <div className="mt-3 flex justify-end gap-2">
          {dialog.kind !== "alert" && <Button size="sm" variant="outline" onClick={() => onReply(false)}>Cancel</Button>}
          <Button size="sm" autoFocus={dialog.kind !== "prompt"} onClick={submit}>OK</Button>
        </div>
      </div>
    </div>
  );
}

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


// --- per-project local state (node list + geometry), like app windows ---
const key = (projectId: string) => `floq:browser-nodes:${projectId}`;
const legacyKey = (projectId: string) => `floq:browser-node:${projectId}`;
interface StoredNode { id: string; x: number; y: number; width: number; height: number }
interface Stored { nodes: StoredNode[]; seen?: boolean }
const OFFSET = 40;

/** Reads the node list; migrates the old single-node record once (open -> node `main`, closed -> only `seen`). */
function read(projectId: string, anchor: { x: number; y: number }): Stored {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (raw) { const v = JSON.parse(raw) as Stored; return { nodes: Array.isArray(v.nodes) ? v.nodes : [], seen: v.seen }; }
    const old = localStorage.getItem(legacyKey(projectId));
    if (old) {
      const o = JSON.parse(old) as { open?: boolean; seen?: boolean; x?: number; y?: number; width?: number; height?: number };
      const migrated: Stored = { nodes: o.open ? [{ id: "main", x: o.x ?? anchor.x, y: o.y ?? anchor.y, width: o.width ?? BROWSER_DEFAULT.width, height: o.height ?? BROWSER_DEFAULT.height }] : [], seen: o.seen || o.open || undefined };
      localStorage.setItem(key(projectId), JSON.stringify(migrated)); localStorage.removeItem(legacyKey(projectId));
      return migrated;
    }
  } catch { /* storage unavailable or corrupt */ }
  return { nodes: [] };
}
const write = (projectId: string, value: Stored) => { try { localStorage.setItem(key(projectId), JSON.stringify(value)); } catch { /* storage unavailable */ } };
const newId = () => Math.random().toString(36).slice(2, 8);

/**
 * The Browser nodes of a canvas (one page each). Opened from the canvas menu or the node's "New browser" button, or one is opened
 * automatically whenever an agent of this project is connected to the browser and no node is open (polled; closing a node keeps it closed until that agent connection ends).
 * Nodes belong to the project they were created on: the list is tagged with its project (a stale list from the previous project is never
 * shown or written under the new one) and the runtime registers each node id to one project.
 */
export function useCanvasBrowsers(client: RuntimeClient | null, projectId: string | null, anchor: { x: number; y: number }, autoOpenPoll = true, projectHasAgents = true) {
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  const [state, setState] = useState<{ projectId: string | null; stored: Stored }>(() => ({ projectId, stored: projectId ? read(projectId, anchor) : { nodes: [] } }));
  // During the render that follows a project switch the old list is still in state: treat it as empty until the effect swaps it.
  const stored = state.projectId === projectId ? state.stored : (projectId ? read(projectId, anchor) : { nodes: [] });
  const storedRef = useRef(stored); storedRef.current = stored;
  const claimed = useRef(new Set<string>());
  const projectRef = useRef(projectId); projectRef.current = projectId;
  useEffect(() => { setState({ projectId, stored: projectId ? read(projectId, anchorRef.current) : { nodes: [] } }); }, [projectId]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const update = useCallback((fn: (prev: Stored) => Stored) => {
    const pid = projectRef.current;
    const next = fn(storedRef.current); storedRef.current = next; if (pid) write(pid, next); setState({ projectId: pid, stored: next });
  }, []);

  // Register this project's nodes with the runtime (it owns "which project is this browser on"). A node that another project already owns
  // (old shared `main` page) gets a fresh page here instead; the owner keeps the page it has open.
  useEffect(() => {
    if (!client || !projectId || state.projectId !== projectId) return;
    const ids = state.stored.nodes.map((n) => n.id).filter((id) => !claimed.current.has(projectId + ":" + id));
    if (!ids.length) return;
    for (const id of ids) claimed.current.add(projectId + ":" + id);
    void Promise.allSettled(ids.map((id) => Promise.resolve().then(() => client.claimBrowserNode(id, projectId)).then(() => null, (e: unknown) => ((e as { status?: number }).status === 409 ? id : null)))).then((r) => {
      const clash = new Set(r.map((x) => (x.status === "fulfilled" ? x.value : null)).filter((x): x is string => !!x));
      if (!clash.size || projectRef.current !== projectId) return;
      update((prev) => ({ ...prev, nodes: prev.nodes.map((n) => (clash.has(n.id) ? { ...n, id: newId() } : n)) }));
    });
  }, [client, projectId, state, update]);


  const dismissed = useRef(false);
  const open = useCallback((at?: { x: number; y: number }): string => {
    const id = newId();
    update((prev) => {
      const base = at ?? { x: anchorRef.current.x + OFFSET * prev.nodes.length, y: anchorRef.current.y + OFFSET * prev.nodes.length };
      return { seen: true, nodes: [...prev.nodes, { id, x: Math.round(base.x), y: Math.round(base.y), width: BROWSER_DEFAULT.width, height: BROWSER_DEFAULT.height }] };
    });
    return BROWSER_PREFIX + id;
  }, [update]);
  const close = useCallback((nodeId: string) => {
    const id = nodeId.startsWith(BROWSER_PREFIX) ? nodeId.slice(BROWSER_PREFIX.length) : nodeId;
    dismissed.current = true; // stays closed until the agent connection ends; a later connection opens a node again
    update((prev) => ({ seen: true, nodes: prev.nodes.filter((n) => n.id !== id) }));
  }, [update]);

  const count = stored.nodes.length;
  useEffect(() => {
    if (!client || !projectId || count > 0 || !autoOpenPoll || !projectHasAgents) return;
    let stopped = false;
    const poll = async () => { try { const s = await client.browserStatus(); if (stopped) return; if ((s.agents ?? 0) === 0) dismissed.current = false; else if (!dismissed.current && storedRef.current.nodes.length === 0) open(); } catch { /* older runtime / disabled */ } };
    void poll();
    const t = setInterval(() => { if (document.visibilityState !== "hidden") void poll(); }, POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [client, projectId, count, autoOpenPoll, projectHasAgents, open]);

  const nodes = useMemo<BrowserNode[]>(() => (!projectId ? [] : stored.nodes.map((n) => ({
    id: BROWSER_PREFIX + n.id, type: "browser" as const, dragHandle: ".browser-drag", selected: selected.has(BROWSER_PREFIX + n.id),
    position: { x: n.x, y: n.y }, width: n.width, height: n.height, data: { projectId, nodeId: n.id },
  }))), [projectId, stored, selected]);

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    const patches = new Map<string, Partial<StoredNode>>();
    for (const c of changes) {
      if (!("id" in c) || !isBrowserId(c.id)) continue;
      const id = c.id.slice(BROWSER_PREFIX.length);
      if (c.type === "select") setSelected((prev) => { const next = new Set(prev); if (c.selected) next.add(c.id); else next.delete(c.id); return next; });
      else if (c.type === "position" && c.position) patches.set(id, { ...patches.get(id), x: c.position.x, y: c.position.y });
      else if (c.type === "dimensions" && c.dimensions && c.setAttributes) patches.set(id, { ...patches.get(id), width: c.dimensions.width, height: c.dimensions.height });
    }
    if (patches.size) update((prev) => ({ ...prev, nodes: prev.nodes.map((n) => (patches.has(n.id) ? { ...n, ...patches.get(n.id) } : n)) }));
  }, [update]);
  return { nodes, onNodesChange, open, close, count, isOpen: count > 0 };
}
