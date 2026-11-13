// Test harness: the canvas Browser node inside a bare ReactFlow, with a mocked /v1/browser/stream (WebSocket) per A.5.
// Query: state=running|disabled|unavailable|stopped. The page reads window.__sent (messages the app sent) and can push
// messages with window.__push(msg).
import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import { BrowserProvider, browserNodeTypes, useCanvasBrowser } from "@/components/canvas/browser-node";

const state = new URLSearchParams(location.search).get("state") ?? "running";
const w = window as unknown as { __sent: Record<string, unknown>[]; __push: (m: unknown) => void; __settings: number; __kbd: string[] };
w.__sent = []; w.__settings = 0; w.__kbd = [];
let sock: MockSocket | null = null;
w.__push = (m) => sock?.onmessage?.({ data: JSON.stringify(m) } as MessageEvent);

class MockSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() {
    sock = this;
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: "state", state }) } as MessageEvent);
      if (state !== "running") return;
      this.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [
        { targetId: "t1", title: "Example", url: "https://example.com/", opener: "user" },
        { targetId: "t2", title: "Agent page", url: "https://agent.test/", opener: "agent" }] }) } as MessageEvent);
      this.onmessage?.({ data: JSON.stringify({ type: "nav", targetId: "t1", url: "https://example.com/", title: "Example", loading: false, canBack: true, canForward: false }) } as MessageEvent);
      this.onmessage?.({ data: JSON.stringify({ type: "clients", agents: 2 }) } as MessageEvent);
      // 400x200 frame (CSS px), scale 2: a wide red/blue page.
      const c = document.createElement("canvas"); c.width = 800; c.height = 400;
      const g = c.getContext("2d")!; g.fillStyle = "#c33"; g.fillRect(0, 0, 400, 400); g.fillStyle = "#33c"; g.fillRect(400, 0, 400, 400);
      this.onmessage?.({ data: JSON.stringify({ type: "frame", n: 1, targetId: "t1", jpeg: c.toDataURL("image/jpeg").split(",")[1], w: 400, h: 200, scale: 2 }) } as MessageEvent);
    }, 30);
  }
  send(data: string) { w.__sent.push(JSON.parse(data)); }
  close() { this.onclose?.(); }
}
(window as unknown as { WebSocket: unknown }).WebSocket = MockSocket;

(w as unknown as { __import: unknown[] }).__import = [];
const client = {
  browserStreamUrl: () => "ws://mock/v1/browser/stream", browserStatus: async () => ({ state: "running", agents: 0 }),
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
  const b = useCanvasBrowser(client, "p1", anchor, false);
  React.useEffect(() => { b.open({ x: 20, y: 20 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = React.useMemo(() => ({ client, openSettings: () => { w.__settings++; }, close: b.close }), [b.close]);
  // Stands in for the canvas wrapper's shortcut handler: it must not see keys typed into the browser.
  return (
    <BrowserProvider value={ctx}>
      <div style={{ width: 1000, height: 700 }} tabIndex={-1} onKeyDown={(e) => w.__kbd.push(e.key)}>
        <ReactFlow nodes={b.nodes} edges={[]} nodeTypes={browserNodeTypes} onNodesChange={b.onNodesChange} defaultViewport={{ x: 0, y: 0, zoom: 1 }} />
      </div>
    </BrowserProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
