import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { IconAppWindow, IconPlugConnected } from "@tabler/icons-react";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionDebugLink } from "@/lib/runtime/types";
import { errorMessage } from "@/lib/runtime/store";
import { openDebugLink, portForwardingSupported, setSessionLinks, setSessionPorts, startForward } from "@/lib/port-forwarding";
import { useActiveForwardSession } from "@/components/window/manual-forward-form";

const POLL_MS = 3000;

async function forward(client: RuntimeClient, sessionId: string, port: number) {
  try {
    await startForward(client, sessionId, port);
    toast.success(`Forwarding localhost:${port}`, { description: "Open it in a browser on this computer." });
  } catch (error) {
    toast.error(`Could not forward port ${port}`, { description: errorMessage(error) });
  }
}

async function openLink(client: RuntimeClient, sessionId: string, link: SessionDebugLink) {
  try {
    await openDebugLink(client, sessionId, link);
  } catch (error) {
    toast.error(`Could not open ${link.label}`, { description: errorMessage(error) });
  }
}

/** One toast for the new preview / DevTools links of a poll ("Flutter app ready" with Open preview / Open DevTools). */
function announceLinks(client: RuntimeClient, sessionId: string, links: SessionDebugLink[]) {
  const preview = links.find((link) => link.kind === "preview");
  const devtools = links.find((link) => link.kind === "devtools");
  if (!preview && !devtools) return;
  const flutter = preview ? preview.label.startsWith("Flutter") : true;
  const title = preview ? (flutter ? "Flutter app ready" : "Dev server ready") : "Flutter DevTools ready";
  const icon = <IconAppWindow className="size-4" aria-hidden="true" />;
  if (!portForwardingSupported) {
    toast(title, { icon, description: "Open the Floq desktop app to preview it on this computer." });
    return;
  }
  const first = preview ?? devtools!;
  toast(title, {
    icon,
    description: preview ? `Port ${preview.port}, from the agent's dev server.` : "Debug the running app in your browser.",
    action: { label: first.kind === "preview" ? "Open preview" : "Open DevTools", onClick: () => void openLink(client, sessionId, first) },
    ...(preview && devtools ? { cancel: { label: "Open DevTools", onClick: () => void openLink(client, sessionId, devtools) } } : {}),
  });
}

/** Polls the active session's listening ports while the window is visible, and offers to forward new ones. */
export function PortWatcher({ client, sessionId }: { client: RuntimeClient | null; sessionId: string | null }) {
  // Ports already announced this run, so a long-lived dev server is not re-announced on every poll or tab switch.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    // Without the desktop app only links are shown (with a hint), so the browser polls too.
    if (!client || !sessionId) return;
    const id = sessionId;
    let cancelled = false;
    async function poll() {
      if (document.visibilityState === "hidden") return;
      try {
        const { ports, links } = await client!.sessionPortsAndLinks(id);
        if (cancelled) return;
        setSessionPorts(id, ports);
        setSessionLinks(id, links);
        const fresh = links.filter((link) => !announced.current.has(`${id}:${link.url}`));
        for (const link of links) {
          announced.current.add(`${id}:${link.url}`);
          // The link toast already covers its ports: no extra "Port N detected" toast for them.
          for (const port of [link.port, ...(link.extraPorts ?? [])]) announced.current.add(`${id}:${port}`);
        }
        announceLinks(client!, id, fresh);
        if (!portForwardingSupported) return;
        for (const { port } of ports) {
          const key = `${id}:${port}`;
          if (announced.current.has(key)) continue;
          announced.current.add(key);
          toast(`Port ${port} detected`, {
            icon: <IconPlugConnected className="size-4" aria-hidden="true" />,
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

/** Mounted once at the app root so new ports are announced even while the footer popover is closed. */
export function ActivePortWatcher() {
  const { client, sessionId } = useActiveForwardSession();
  return <PortWatcher client={client} sessionId={sessionId} />;
}
