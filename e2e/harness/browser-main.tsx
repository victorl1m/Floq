// Test harness: the canvas Browser node inside a bare ReactFlow, with a mocked /v1/browser/stream (WebSocket) per A.5.
// Query: link=1 (canvas Link mode), state=running|disabled|unavailable|stopped, zoom=<canvas zoom>, linked=<n linked agents>, title/url=<page nav info>.
// The page reads window.__sent (messages the app sent) and can push messages with window.__push(msg) (to every open socket);
// window.__zoom(z) sets the canvas zoom, window.__viewport() reads it. One MockSocket per Browser node (window.__sockets).
import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider, SelectionMode, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import { CanvasCtx, type CanvasCtxValue } from "@/components/canvas/canvas-context";
import { BrowserProvider, browserNodeTypes, queueBrowserUrl, useCanvasBrowsers, type NewBrowserOptions } from "@/components/canvas/browser-node";

const q = new URLSearchParams(location.search);
const state = q.get("state") ?? "running";
const navTitle = q.get("title") ?? "Example"; const navUrl = q.get("url") ?? "https://example.com/";
const linkedCount = Number(q.get("linked") ?? 0);
const w = window as unknown as { __sent: Record<string, unknown>[]; __push: (m: unknown) => void; __settings: number; __kbd: string[] };
w.__sent = []; w.__settings = 0; w.__kbd = [];
const socks: MockSocket[] = [];
w.__push = (m) => socks.forEach((x) => x.onmessage?.({ data: JSON.stringify(m) } as MessageEvent));
(w as unknown as { __urls: string[] }).__urls = [];
(w as unknown as { __opened: unknown[] }).__opened = [];
(w as unknown as { __unlinks: unknown[] }).__unlinks = [];
(w as unknown as { __startLink: string[] }).__startLink = [];

class MockSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(url: string) {
    socks.push(this); (w as unknown as { __urls: string[] }).__urls.push(url);
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: "state", state }) } as MessageEvent);
      if (state !== "running") return;
      this.onmessage?.({ data: JSON.stringify({ type: "page", targetId: "t1", created: true }) } as MessageEvent);
      this.onmessage?.({ data: JSON.stringify({ type: "nav", targetId: "t1", url: navUrl, title: navTitle, loading: false, canBack: true, canForward: false }) } as MessageEvent);
      this.onmessage?.({ data: JSON.stringify({ type: "clients", agents: 2 }) } as MessageEvent);
      // 400x200 frame (CSS px), scale 2: a wide red/blue page.
      const c = document.createElement("canvas"); c.width = 800; c.height = 400;
      const g = c.getContext("2d")!; g.fillStyle = "#c33"; g.fillRect(0, 0, 400, 400); g.fillStyle = "#33c"; g.fillRect(400, 0, 400, 400);
      this.onmessage?.({ data: JSON.stringify({ type: "frame", n: 1, targetId: "t1", jpeg: c.toDataURL("image/jpeg").split(",")[1], w: 400, h: 200, scale: 2 }) } as MessageEvent);
    }, 30);
  }
  send(data: string) { w.__sent.push(JSON.parse(data)); }
  /* eslint-disable-next-line */
  close() { this.onclose?.(); }
}
(window as unknown as { WebSocket: unknown }).WebSocket = MockSocket;

(w as unknown as { __import: unknown[] }).__import = [];
(w as unknown as { __patches: unknown[] }).__patches = [];
(w as unknown as { __overrides: unknown[] }).__overrides = [];
const client = {
  claimBrowserNode: async () => undefined, // the runtime registers each node to its project before a card connects
  browserEgressOverride: async (server: boolean) => { (w as unknown as { __overrides: unknown[] }).__overrides.push(server); return {}; },
  updateSettings: async (patch: unknown) => { (w as unknown as { __patches: unknown[] }).__patches.push(patch); return {}; },
  browserStreamUrl: (nodeId: string) => `ws://mock/v1/browser/stream?node=${nodeId}`, browserStatus: async () => ({ state: "running", agents: 0 }),
  // Mocked import API (§A.13): a file containing "bad" is refused, anything else previews two domains plus bookmarks.
  browserImportPreview: async (content: string) => {
    (w as unknown as { __import: unknown[] }).__import.push({ preview: content });
    if (content.includes("bad")) throw Object.assign(new Error("Nothing importable found in that file"), { status: 400 });
    return { importId: "imp1", format: "netscape", cookies: { total: 5, domains: [{ domain: "example.com", count: 3 }, { domain: "other.org", count: 2 }], expired: 1, malformed: 0 }, bookmarks: { count: 4 }, skippedStorage: false };
  },
  browserImportCommit: async (importId: string, domains: string[], bookmarks: boolean) => {
    (w as unknown as { __import: unknown[] }).__import.push({ commit: { importId, domains, bookmarks } });
    return { imported: 3, failed: 0, bookmarks: bookmarks ? 4 : 0 };
  },
} as never;
const anchor = { x: 20, y: 20 };

function App() {
  const b = useCanvasBrowsers(client, "p1", anchor, false);
  const rf = useReactFlow();
  React.useEffect(() => { if (b.count === 0) b.open({ x: 20, y: 20 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    (w as unknown as { __zoom: (z: number) => void }).__zoom = (z) => { rf.setViewport({ x: 0, y: 0, zoom: z }); };
    (w as unknown as { __viewport: () => unknown }).__viewport = () => rf.getViewport();
  }, [rf]);
  const linked = React.useMemo(() => Array.from({ length: linkedCount }, (_, i) => ({ sessionId: `00000000-0000-4000-8000-00000000000${i}`, title: `Agent ${i + 1}` })), []);
  const ctx = React.useMemo(() => ({
    client, openSettings: () => { w.__settings++; }, close: b.close, linkedAgents: () => linked,
    newBrowser: (opts?: NewBrowserOptions) => { const id = b.open(); (w as unknown as { __opened: unknown[] }).__opened.push({ id, ...opts }); if (opts?.url) queueBrowserUrl(id, opts.url); },
    unlink: (nodeId: string, sessionId: string) => { (w as unknown as { __unlinks: unknown[] }).__unlinks.push({ nodeId, sessionId }); },
  }), [b.close, b.open, linked]);
  // Stands in for the canvas wrapper's shortcut handler: it must not see keys typed into the browser.
  const canvasCtx = React.useMemo(() => ({ linkMode: q.get("link") ? { from: null } : null, startLink: (id: string) => { (w as unknown as { __startLink: string[] }).__startLink.push(id); } }) as unknown as CanvasCtxValue, []);
  return (
    <CanvasCtx.Provider value={canvasCtx}>
    <BrowserProvider value={ctx}>
      <div style={{ width: "100vw", height: "100vh" }} tabIndex={-1} onKeyDown={(e) => w.__kbd.push(e.key)}>
        <ReactFlow nodes={b.nodes} edges={[]} nodeTypes={browserNodeTypes} onNodesChange={b.onNodesChange} selectionMode={SelectionMode.Partial} defaultViewport={{ x: 0, y: 0, zoom: Number(q.get("zoom") ?? 1) }} />
      </div>
    </BrowserProvider>
    </CanvasCtx.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
