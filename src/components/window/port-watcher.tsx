import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import { portForwardingSupported, setSessionPorts, startForward } from "@/lib/port-forwarding";
import { useActiveForwardSession } from "@/components/window/manual-forward-form";

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

/** Mounted once at the app root so new ports are announced even while the footer popover is closed. */
export function ActivePortWatcher() {
  const { client, sessionId } = useActiveForwardSession();
  return <PortWatcher client={client} sessionId={sessionId} />;
}
