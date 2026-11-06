import { useEffect, useRef, useState } from "react";
import { IconAppWindow, IconExternalLink, IconPlayerStop } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/open-external";
import { portForwardingSupported, startForward, usePortForwarding } from "@/lib/port-forwarding";
import { openRightSidebar } from "@/lib/right-sidebar";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionDisplay, SessionSummary } from "@/lib/runtime/types";
import { isLive } from "../provider";
import { PanelEmpty, PanelError } from "./panel-states";

const POLL_MS = 3_000;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Xpra HTML5 client served by the display itself; the local port equals the remote one (port-forwarding.ts).
 * The password goes in the URL only for the in-app iframe (never persisted or sent off this computer; xpra uses an
 * HMAC challenge over the websocket). Pop out opens the URL without it, so it never lands in browser history.
 */
export function xpraClientUrl(port: number, token: string | null): string {
  const url = new URL(`http://127.0.0.1:${port}/index.html`);
  if (token) url.searchParams.set("password", token);
  url.searchParams.set("sound", "false");
  return url.toString();
}

/**
 * "App window" tab: the agent's Linux GUI app (Tauri, Flutter desktop) running on its Xpra display in the sandbox.
 * Desktop app only: the HTML5 client is reached through the port tunnel at 127.0.0.1.
 */
export default function AppWindowTab({ client, session, active }: { client: RuntimeClient | null; session: SessionSummary | undefined; active: boolean }) {
  const sessionId = session && isLive(session.state) ? session.id : null;
  const [display, setDisplay] = useState<SessionDisplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forwardError, setForwardError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const { forwarded } = usePortForwarding();
  const forwarding = useRef(false);

  useEffect(() => {
    setDisplay(null);
    setError(null);
    setForwardError(null);
    if (!client || !sessionId || !active) return;
    let stopped = false;
    const load = async () => {
      try {
        const next = await client.sessionDisplay(sessionId);
        if (!stopped) { setDisplay(next); setError(null); }
      } catch (failure) {
        if (!stopped) setError(errorMessage(failure));
      }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [client, sessionId, active]);

  const port = display?.running ? display.port : null;
  const isForwarded = port !== null && forwarded[port] === sessionId;

  useEffect(() => {
    if (!client || !sessionId || port === null || isForwarded || !portForwardingSupported || forwarding.current) return;
    forwarding.current = true;
    startForward(client, sessionId, port)
      .then(() => setForwardError(null))
      .catch((failure) => setForwardError(errorMessage(failure)))
      .finally(() => { forwarding.current = false; });
  }, [client, sessionId, port, isForwarded]);

  if (!portForwardingSupported) {
    return <PanelEmpty icon={<IconAppWindow />} title="Desktop app only" hint="The app window is shown through a port tunnel, which needs the Floq desktop app." />;
  }
  if (!sessionId) {
    return <PanelEmpty icon={<IconAppWindow />} title="No running agent" hint="Open a running agent to see the app window it started." />;
  }
  if (error) return <PanelError message={error} />;
  if (!display) return <PanelEmpty icon={<IconAppWindow />} title="Checking the display…" />;
  if (!display.running || !display.token || port === null) {
    return <PanelEmpty icon={<IconAppWindow />} title="No app window yet" hint={'When the agent runs "floq display start" and launches a Linux desktop app (Tauri, Flutter) on it, the window appears here.'} />;
  }
  if (forwardError) return <PanelError message={`Could not forward port ${port}: ${forwardError}`} />;

  const url = xpraClientUrl(port, display.token);
  const token = display.token;
  async function popOut() {
    try {
      await copyText(token);
      toast("Display password copied", { description: "Paste it when the browser asks for the password." });
    } catch {
      toast.error("Could not copy the display password");
    }
    await openExternal(xpraClientUrl(port!, null));
  }
  async function stop() {
    if (!client || !sessionId) return;
    setStopping(true);
    try {
      const result = await client.stopSessionDisplay(sessionId);
      if (!result.stopped) toast.error("The display was not running");
    } catch (failure) {
      toast.error("Could not stop the display", { description: errorMessage(failure) });
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Display on port {port}</span>
        <Button type="button" variant="ghost" size="xs" onClick={() => void popOut()} title="Open the app window in your browser (copies its password)"><IconExternalLink />Pop out</Button>
        <Button type="button" variant="ghost" size="xs" disabled={stopping} onClick={() => void stop()} title="Stop the display and the apps on it"><IconPlayerStop />Stop</Button>
      </div>
      {isForwarded && active ? (
        <iframe key={url} title="App window" src={url} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-black" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" allow="clipboard-write; fullscreen" />
      ) : (
        <PanelEmpty icon={<IconAppWindow />} title="Connecting…" />
      )}
    </div>
  );
}

/** Toast when an agent of this user starts its display ("floq display start" sends a display-started event). */
export function useDisplayAnnouncements(client: RuntimeClient | null, sessions: SessionSummary[]) {
  const titles = useRef(new Map<string, string>());
  titles.current = new Map(sessions.map((item) => [item.id, item.title]));
  useEffect(() => {
    if (!client || !portForwardingSupported) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const connect = () => {
      if (stopped) return;
      try { ws = new WebSocket(client.eventsUrl()); } catch { return; }
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as { type?: string; sessionId?: string };
          if (frame?.type !== "display-started" || typeof frame.sessionId !== "string") return;
          const title = titles.current.get(frame.sessionId) ?? "An agent";
          toast(`${title} opened an app window`, { action: { label: "Show", onClick: () => openRightSidebar("app") } });
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        ws = null;
        if (!stopped) timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, [client]);
}
