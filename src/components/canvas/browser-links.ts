// Agent <-> Browser node wires. They are drawn with the same "wire" edge as agent-to-agent links (kind "manual": same colour, dashes,
// handles, link mode and delete button); this file only maps them to CanvasLink-shaped edges and keeps them in sync with the runtime.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { BrowserLink } from "@/lib/runtime/types";
import type { CanvasLink } from "./canvas-data";
import { BROWSER_PREFIX } from "./browser-node";

export const BROWSER_WIRE_PREFIX = "bwire:";
export const isBrowserWireId = (id: string) => id.startsWith(BROWSER_WIRE_PREFIX);
export const browserWireId = (nodeId: string, sessionId: string) => `${BROWSER_WIRE_PREFIX}${nodeId}:${sessionId}`;
/** `bwire:<nodeId>:<sessionId>` -> parts (node id without the `browser:` prefix; node ids never contain ":"). */
export const parseBrowserWire = (id: string) => { const [nodeId, sessionId] = id.slice(BROWSER_WIRE_PREFIX.length).split(":"); return { nodeId, sessionId }; };
const POLL_MS = 15_000;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const bare = (flowId: string) => (flowId.startsWith(BROWSER_PREFIX) ? flowId.slice(BROWSER_PREFIX.length) : flowId);

export function useBrowserLinks(client: RuntimeClient | null, projectId: string | null | undefined, titleOf: (sessionId: string) => string) {
  const [links, setLinks] = useState<BrowserLink[]>([]);
  const hidden = useRef(new Set<string>()); // wires deleted locally: an in-flight poll must not resurrect them
  const refresh = useCallback(async () => {
    if (!client || !projectId) { setLinks([]); return; }
    try { setLinks((await client.browserLinks(projectId)).filter((l) => !hidden.current.has(browserWireId(l.nodeId, l.sessionId)))); } catch { /* older runtime or browser off: no wires */ }
  }, [client, projectId]);
  useEffect(() => {
    hidden.current.clear();
    void refresh();
    const t = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  /** `node` is the flow id (`browser:xyz`). An agent drives one node at a time: linking it to another replaces the old wire. */
  const link = useCallback((node: string, sessionId: string) => {
    if (!client) return;
    const nodeId = bare(node);
    if (links.some((l) => l.nodeId === nodeId && l.sessionId === sessionId)) { toast.info("Already linked", { description: `${titleOf(sessionId)} already drives this browser.` }); return; }
    const before = links;
    hidden.current.delete(browserWireId(nodeId, sessionId));
    setLinks((list) => [...list.filter((l) => l.sessionId !== sessionId), { nodeId, sessionId, projectId: projectId ?? null }]);
    client.linkBrowser(nodeId, sessionId).then(({ replacedNode }) => {
      toast.success(`${titleOf(sessionId)} linked to the browser`, { description: replacedNode ? "It now drives this page instead of its previous browser." : "Its browser tools now drive this page. You can watch it live." });
    }).catch((error) => { setLinks(before); toast.error("Could not link the browser", { description: errorMessage(error) }); });
  }, [client, links, projectId, titleOf]);

  const unlink = useCallback((nodeId: string, sessionId: string) => {
    if (!client) return;
    const before = links;
    hidden.current.add(browserWireId(nodeId, sessionId));
    setLinks((list) => list.filter((l) => !(l.nodeId === nodeId && l.sessionId === sessionId)));
    client.unlinkBrowser(nodeId, sessionId).catch((error) => { hidden.current.delete(browserWireId(nodeId, sessionId)); setLinks(before); toast.error("Could not unlink the browser", { description: errorMessage(error) }); });
  }, [client, links]);

  /** A node was closed on the canvas: its wires go with it. */
  const dropNode = useCallback((node: string) => {
    const nodeId = bare(node);
    setLinks((list) => list.filter((l) => l.nodeId !== nodeId));
    if (client) void client.removeBrowserNode(nodeId).catch(() => undefined);
  }, [client]);

  const linkedAgents = useCallback((node: string) => links.filter((l) => l.nodeId === bare(node)).map((l) => ({ sessionId: l.sessionId, title: titleOf(l.sessionId) })), [links, titleOf]);
  /** CanvasLink-shaped wires (agent -> browser node) between existing nodes only, for the standard wire edge. */
  const wires = useCallback((existingNodes: Set<string>, sessionIds: Set<string>): CanvasLink[] => links
    .filter((l) => existingNodes.has(BROWSER_PREFIX + l.nodeId) && sessionIds.has(l.sessionId))
    .map((l) => ({ id: browserWireId(l.nodeId, l.sessionId), projectId: l.projectId ?? "", fromSessionId: l.sessionId, toSessionId: BROWSER_PREFIX + l.nodeId, kind: "manual" as const, createdAt: "", lastMessageAt: null, messageCount: 0 })), [links]);
  return useMemo(() => ({ links, link, unlink, dropNode, linkedAgents, wires, refresh }), [links, link, unlink, dropNode, linkedAgents, wires, refresh]);
}
