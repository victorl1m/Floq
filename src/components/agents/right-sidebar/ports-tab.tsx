import { useEffect, useRef } from "react";
import { IconExternalLink, IconPlugConnected } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { portForwardingSupported, setSessionPorts, startForward, stopForward, usePortForwarding } from "@/lib/port-forwarding";
import { ManualForwardForm } from "@/components/window/manual-forward-form";
import { PanelEmpty } from "./panel-states";

const POLL_MS = 3000;

async function forward(client: RuntimeClient, sessionId: string, port: number) {
  try {
    await startForward(client, sessionId, port);
    toast.success(`Forwarding localhost:${port}`);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

/** Polls the active session's listening ports while the window is visible, and offers to forward new ones. */
export function PortWatcher({ client, sessionId }: { client: RuntimeClient | null; sessionId: string | null }) {
  // Ports already announced this run, so a long-lived dev server is not re-announced on every poll or tab switch.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (!client || !sessionId || !portForwardingSupported) return;
    const id = sessionId;
    let cancelled = false;
    async function poll() {
      if (document.visibilityState === "hidden") return;
      try {
        const ports = await client!.sessionPorts(id);
        if (cancelled) return;
        setSessionPorts(id, ports);
        for (const { port } of ports) {
          const key = `${id}:${port}`;
          if (announced.current.has(key)) continue;
          announced.current.add(key);
          toast(`Port ${port} detected`, {
            description: "Forward it to reach it from this computer.",
            action: { label: "Forward", onClick: () => void forward(client!, id, port) },
          });
        }
      } catch { /* session may have stopped; the next poll retries */ }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client, sessionId]);
  return null;
}

export default function PortsTab({ client, sessionId }: { client: RuntimeClient; sessionId: string }) {
  const { ports, forwarded } = usePortForwarding();
  const list = ports[sessionId] ?? [];
  if (!portForwardingSupported) {
    return <PanelEmpty icon={<IconPlugConnected />} title="Forwarding needs the desktop app" hint="Open Floq's desktop app to reach ports from this session on your computer." />;
  }
  const manualForm = <div className="border-t border-border p-3"><ManualForwardForm client={client} sessionId={sessionId} /></div>;
  const manualOnly = Object.entries(forwarded).filter(([port, owner]) => owner === sessionId && !list.some((item) => item.port === Number(port))).map(([port]) => Number(port));
  if (!list.length && !manualOnly.length) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1"><PanelEmpty icon={<IconPlugConnected />} title="No listening ports" hint="Ports the agent opens (dev servers, OAuth callbacks) show up here." /></div>
        {manualForm}
      </div>
    );
  }
  const rows = [...list.map(({ port }) => port), ...manualOnly].sort((a, b) => a - b);
  return (
    <div className="flex h-full flex-col">
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      {rows.map((port) => {
        const owner = forwarded[port];
        const active = owner === sessionId;
        return (
          <li key={port} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
            <span className="min-w-0 flex-1 truncate font-medium tabular-nums">localhost:{port}</span>
            {owner && !active && <span className="text-muted-foreground">in use by another session</span>}
            {active && (
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Open localhost:${port} in browser`} onClick={() => void openUrl(`http://localhost:${port}`)}>
                <IconExternalLink />
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!!owner && !active}
              onClick={() => void (active ? stopForward(port) : forward(client, sessionId, port))}
            >
              {active ? "Stop" : "Forward"}
            </Button>
          </li>
        );
      })}
    </ul>
    {manualForm}
    </div>
  );
}

/** Mounted once at the app root so new ports are announced even while the side panel is closed. */
export function ActivePortWatcher() {
  const { client, view, selectedId, selectedTerminalId } = useRuntime();
  const id = view === "terminal" ? selectedTerminalId : view === "session" ? selectedId : null;
  return <PortWatcher client={client} sessionId={id} />;
}
