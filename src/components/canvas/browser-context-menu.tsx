// Right-click menu of the canvas Browser node (page and header). Every item works through the existing stream messages or locally
// (clipboard, the current frame); anything the stream cannot do yet is left out or disabled with the reason in its title.
// Shift+right-click on the page skips this menu and reaches the page itself.
import { useCallback, useContext, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  IconArrowLeft, IconArrowRight, IconCopy, IconDeviceFloppy, IconExternalLink, IconHandStop, IconLink, IconLinkOff, IconPhoto,
  IconRefresh, IconSquarePlus, IconCopyPlus, IconX, IconZoomIn, IconZoomOut, IconZoomReset, IconPlayerStop,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import { CanvasCtx } from "@/components/canvas/canvas-context";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/open-external";
import { errorMessage } from "@/lib/runtime/store";
import type { BrowserClientMessage, BrowserFrame, BrowserNav } from "@/lib/runtime/browser-types";

/** Page zoom steps (Emulation metrics: CSS viewport / zoom, device scale x zoom). */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export function nextZoom(zoom: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - zoom) < 0.001);
  const at = i < 0 ? ZOOM_STEPS.indexOf(1) : i;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + dir))];
}

/** The current frame (JPEG) as a PNG blob at its full resolution. */
export async function framePng(frame: BrowserFrame): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${frame.jpeg}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/png"));
}

async function copyImage(blob: Blob): Promise<void> {
  if (isTauri()) {
    const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeImage(new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("This browser cannot put images on the clipboard");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function screenshotName(url: string | undefined, now = new Date()): string {
  let host = "page";
  try { if (url) host = new URL(url).hostname.replace(/^www\./, "") || "page"; } catch { /* keep "page" */ }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${host.replace(/[^a-z0-9.-]/gi, "_")} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const isWebUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);
/** The desktop webview has no reliable download path for in-memory files: there Save is replaced by Copy image. */
const canSaveFiles = () => !isTauri();

export interface BrowserMenuProps {
  children: ReactNode;
  /** Node id incl. the `browser:` prefix. */
  nodeId: string;
  live: boolean;
  nav: BrowserNav | null;
  frame: BrowserFrame | null;
  control: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  send: (msg: BrowserClientMessage) => void;
  linked: Array<{ sessionId: string; title: string }>;
  newBrowser: (opts?: { url?: string; near?: string }) => void;
  unlink?: (bareNodeId: string, sessionId: string) => void;
  closeNode: () => void;
}

export function BrowserContextMenu({ children, nodeId, live, nav, frame, control, zoom, setZoom, send, linked, newBrowser, unlink, closeNode }: BrowserMenuProps) {
  const canvas = useContext(CanvasCtx);
  const url = nav?.url;
  const webUrl = isWebUrl(url) ? url : undefined;
  const bare = nodeId.replace(/^browser:/, "");

  const withFrame = useCallback(async (what: "copy" | "save") => {
    if (!frame) return;
    try {
      const png = await framePng(frame);
      if (what === "copy") { await copyImage(png); toast.success("Screenshot copied", { description: "The visible page is on your clipboard." }); }
      else { saveBlob(png, screenshotName(url)); toast.success("Screenshot saved", { description: "Look in your downloads." }); }
    } catch (error) {
      toast.error(what === "copy" ? "Could not copy the screenshot" : "Could not save the screenshot", { description: errorMessage(error) });
    }
  }, [frame, url]);

  const noPage = live ? undefined : "The browser is not running";
  const noUrl = !webUrl ? "Only http(s) pages" : undefined;
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild
        // Shift+right-click: no menu (preventDefault also keeps the native one away); the pointer events reach the page.
        onContextMenu={(e) => { if (e.shiftKey) e.preventDefault(); }}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="browser-menu" aria-label="Browser" className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem disabled={!live || !nav?.canBack} title={noPage} onSelect={() => send({ type: "nav.back" })}><IconArrowLeft />Back</ContextMenuItem>
        <ContextMenuItem disabled={!live || !nav?.canForward} title={noPage} onSelect={() => send({ type: "nav.forward" })}><IconArrowRight />Forward</ContextMenuItem>
        {nav?.loading
          ? <ContextMenuItem disabled={!live} onSelect={() => send({ type: "nav.stop" })}><IconPlayerStop />Stop loading</ContextMenuItem>
          : <ContextMenuItem disabled={!live} title={noPage} onSelect={() => send({ type: "nav.reload" })}><IconRefresh />Reload</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!url} onSelect={() => { if (url) void copyText(url).then(() => toast.success("Address copied"), (e) => toast.error("Could not copy the address", { description: errorMessage(e) })); }}><IconCopy />Copy page address</ContextMenuItem>
        <ContextMenuItem disabled={!webUrl} title={noUrl} onSelect={() => { if (webUrl) void openExternal(webUrl); }}><IconExternalLink />Open in your browser</ContextMenuItem>
        <ContextMenuItem disabled={!webUrl} title={noUrl} onSelect={() => { if (webUrl) newBrowser({ url: webUrl }); }}><IconSquarePlus />Open in new browser node</ContextMenuItem>
        <ContextMenuItem onSelect={() => newBrowser({ url: webUrl, near: nodeId })}><IconCopyPlus />Duplicate node</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!frame} title={frame ? undefined : "No page image yet"} onSelect={() => void withFrame("copy")}><IconPhoto />Copy screenshot</ContextMenuItem>
        <ContextMenuItem disabled={!frame || !canSaveFiles()} title={!frame ? "No page image yet" : canSaveFiles() ? undefined : "Not available in the desktop app yet: use Copy screenshot"} onSelect={() => void withFrame("save")}><IconDeviceFloppy />Save screenshot…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!live || zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onSelect={(e) => { e.preventDefault(); setZoom(nextZoom(zoom, 1)); }}><IconZoomIn />Zoom in</ContextMenuItem>
        <ContextMenuItem disabled={!live || zoom <= ZOOM_STEPS[0]} onSelect={(e) => { e.preventDefault(); setZoom(nextZoom(zoom, -1)); }}><IconZoomOut />Zoom out</ContextMenuItem>
        <ContextMenuItem disabled={!live || zoom === 1} onSelect={() => setZoom(1)}><IconZoomReset />Reset zoom<ContextMenuShortcut data-testid="browser-menu-zoom">{Math.round(zoom * 100)}%</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!live} title={noPage} onSelect={() => send({ type: "control.set", held: !control })}><IconHandStop />{control ? "Give control back to agents" : "Take control"}</ContextMenuItem>
        {canvas?.startLink && <ContextMenuItem onSelect={() => canvas.startLink(nodeId)}><IconLink />Link to an agent…</ContextMenuItem>}
        {unlink && linked.length === 1 && <ContextMenuItem onSelect={() => unlink(bare, linked[0].sessionId)}><IconLinkOff />Unlink {linked[0].title}</ContextMenuItem>}
        {unlink && linked.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger><IconLinkOff />Unlink agent</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {linked.map((a) => <ContextMenuItem key={a.sessionId} onSelect={() => unlink(bare, a.sessionId)}>{a.title}</ContextMenuItem>)}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={closeNode}><IconX />Close browser</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
