import { useEffect } from "react";
import { toast } from "sonner";
import { useRuntime } from "@/lib/runtime/store";
import type { AgentMessageEvent } from "@/lib/runtime/types";

/**
 * Headless: listens on the runtime events socket and announces a message that crossed projects
 * ("Agent A messaged Agent B in project X") with the shared toast. Informational only.
 */
export function CrossProjectToaster() {
  const { client } = useRuntime();
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const seen = new Set<string>();
    const connect = () => {
      if (stopped) return;
      try { ws = new WebSocket(client.eventsUrl()); } catch { return; }
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as AgentMessageEvent;
          if (event?.type !== "agent-message" || event.kind !== "ask" || !event.cross) return;
          const key = `${event.linkId}|${event.at}`;
          if (seen.has(key)) return;
          seen.add(key);
          toast.info(`${event.cross.fromTitle} messaged ${event.cross.toTitle} in project ${event.cross.toProject}`, {
            description: `From project ${event.cross.fromProject}.`,
          });
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
  return null;
}
