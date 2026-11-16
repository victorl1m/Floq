// agy swarm mirror: virtual agents (workers/subagents inside an Antigravity session) as canvas data.
// Seeded over REST, then kept live by `virtual-agents` frames on /v1/events. An old runtime (404) simply yields nothing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node, NodeChange } from "@xyflow/react";
import type { RuntimeClient } from "@/lib/runtime/client";
import { subscribeConnect, subscribeFrames } from "@/lib/runtime/event-frames";
import type { VirtualAgent, VirtualAgentsFrame } from "@/lib/runtime/types";

export const VIRTUAL_PREFIX = "agy:";
export const isVirtualId = (id: string) => id.startsWith(VIRTUAL_PREFIX);
export const VIRTUAL_SIZE = { width: 320, height: 260 };
const GAP = { x: 40, y: 70 };
const SHOW_KILLED_KEY = "floq.virtualAgents.showKilled";

export type VirtualAgentNodeData = { agent: VirtualAgent } & Record<string, unknown>;
export type VirtualAgentNode = Node<VirtualAgentNodeData, "virtual-agent">;

/** Parses a pushed frame; anything else yields null. */
export function parseVirtualFrame(raw: unknown): VirtualAgentsFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as Partial<VirtualAgentsFrame>;
  if (frame.type !== "virtual-agents" || typeof frame.hostSessionId !== "string" || !Array.isArray(frame.agents)) return null;
  return frame as VirtualAgentsFrame;
}

export function useVirtualAgents(client: RuntimeClient | null, projectId: string | null) {
  const [byHost, setByHost] = useState<Record<string, VirtualAgent[]>>({});
  useEffect(() => {
    setByHost({});
    if (!client || !projectId) return;
    let stopped = false;
    // Hosts that got a pushed frame, with the tick of that frame: a REST seed never overwrites a host that was updated after the seed began.
    let tick = 0;
    const framedAt = new Map<string, number>();
    const seed = async () => {
      const began = tick;
      try {
        const agents = await client.virtualAgents(projectId);
        if (stopped) return;
        const fresh: Record<string, VirtualAgent[]> = {};
        for (const agent of agents) (fresh[agent.hostSessionId] ??= []).push(agent);
        setByHost((current) => {
          const next: Record<string, VirtualAgent[]> = {};
          for (const host of Object.keys(current)) if ((framedAt.get(host) ?? -1) > began) next[host] = current[host];
          for (const host of Object.keys(fresh)) if (!((framedAt.get(host) ?? -1) > began)) next[host] = fresh[host];
          return next;
        });
      } catch { /* old runtime (404) or offline: no virtual agents */ }
    };
    // The runtime pushes a snapshot right after subscribe, so the REST seed matters for the first paint only (and is re-run on reconnect as a cheap fallback).
    const offFrames = subscribeFrames((raw) => {
      const frame = parseVirtualFrame(raw);
      if (!frame || frame.projectId !== projectId) return;
      framedAt.set(frame.hostSessionId, ++tick);
      setByHost((current) => {
        const next = { ...current };
        if (frame.agents.length) next[frame.hostSessionId] = frame.agents; else delete next[frame.hostSessionId];
        return next;
      });
    });
    const offConnect = subscribeConnect(() => void seed());
    void seed();
    return () => { stopped = true; offFrames(); offConnect(); };
  }, [client, projectId]);
  return useMemo(() => {
    // The same agy:<id> under two hosts (cross-linked roster) must not become duplicate node ids: first host wins.
    const seen = new Set<string>();
    return Object.values(byHost).flat().filter((agent) => !seen.has(agent.id) && !!seen.add(agent.id));
  }, [byHost]);
}

export function useShowKilled(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => { try { return localStorage.getItem(SHOW_KILLED_KEY) === "1"; } catch { return false; } });
  const set = useCallback((next: boolean) => { setValue(next); try { localStorage.setItem(SHOW_KILLED_KEY, next ? "1" : "0"); } catch { /* storage unavailable */ } }, []);
  return [value, set];
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Tidy-tree layout under each host: children of a node form a row below it, subtrees never overlap.
 * `hostRect` resolves a Floq session id to its node rect (undefined = host not on this canvas, its agents are skipped).
 */
export function layoutVirtual(agents: VirtualAgent[], hostRect: (sessionId: string) => Rect | undefined, sizeOf: (id: string) => { width: number; height: number } = () => VIRTUAL_SIZE, obstacles: Rect[] = []): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const kids = new Map<string, VirtualAgent[]>();
  for (const agent of agents) (kids.get(agent.parentId) ?? kids.set(agent.parentId, []).get(agent.parentId)!).push(agent);
  const hosts = new Set(agents.map((agent) => agent.hostSessionId));
  for (const host of hosts) {
    const rect = hostRect(host);
    if (!rect) continue;
    let cursor = rect.x;
    const place = (parentId: string, top: number, seen: Set<string>) => {
      for (const agent of kids.get(parentId) ?? []) {
        if (seen.has(agent.id)) continue;
        seen.add(agent.id);
        const size = sizeOf(agent.id);
        const start = cursor;
        const below = kids.get(agent.id) ?? [];
        if (below.length) place(agent.id, top + size.height + GAP.y, seen);
        const end = cursor;
        // A parent sits centred above its children's span, a leaf takes the next free column.
        let x: number;
        if (below.length && end > start) x = Math.max(start, Math.round((start + end - GAP.x) / 2 - size.width / 2));
        else x = start;
        // Never land on a node that is already there (e.g. a Floq subagent of the same host placed by the session layout).
        for (let guard = 0; guard < 50; guard++) {
          const hit = obstacles.find((o) => x < o.x + o.width + GAP.x / 2 && x + size.width > o.x - GAP.x / 2 && top < o.y + o.height + 20 && top + size.height > o.y - 20);
          if (!hit) break;
          x = hit.x + hit.width + GAP.x;
        }
        out.set(agent.id, { x, y: top });
        cursor = Math.max(cursor, x + size.width + GAP.x);
      }
    };
    place(host, rect.y + rect.height + GAP.y, new Set());
  }
  return out;
}

/** Canvas nodes for the virtual agents; user drags/resizes are kept per node id. */
export function useVirtualAgentNodes(agents: VirtualAgent[], showKilled: boolean, hostRect: (sessionId: string) => Rect | undefined, hostKey: string, obstacles: () => Rect[] = () => []) {
  const [overrides, setOverrides] = useState<Record<string, Partial<Rect>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    // A hidden (killed) node hides its subtree too, so wires never dangle.
    const hidden = (agent: VirtualAgent, depth = 0): boolean => {
      if (!showKilled && agent.status === "killed") return true;
      const parent = byId.get(agent.parentId);
      return !!parent && depth < 16 && hidden(parent, depth + 1);
    };
    return agents.filter((agent) => !hidden(agent));
  }, [agents, showKilled]);
  const hostRectRef = useRef(hostRect);
  hostRectRef.current = hostRect;
  const obstaclesRef = useRef(obstacles);
  obstaclesRef.current = obstacles;
  const sizes = useRef<Record<string, Partial<Rect>>>({});
  sizes.current = overrides;
  const auto = useMemo(
    () => layoutVirtual(visible, (id) => hostRectRef.current(id), (id) => ({ width: overrides[id]?.width ?? VIRTUAL_SIZE.width, height: overrides[id]?.height ?? VIRTUAL_SIZE.height }), obstaclesRef.current()),
    // hostKey changes when a host node moves/resizes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, hostKey, overrides],
  );
  const nodes = useMemo<VirtualAgentNode[]>(() => visible.flatMap((agent) => {
    const base = auto.get(agent.id);
    if (!base) return [];
    const o = overrides[agent.id] ?? {};
    return [{
      id: agent.id, type: "virtual-agent", position: { x: o.x ?? base.x, y: o.y ?? base.y },
      width: o.width ?? VIRTUAL_SIZE.width, height: o.height ?? VIRTUAL_SIZE.height,
      deletable: false, connectable: false, selected: selected.has(agent.id), data: { agent },
    } as VirtualAgentNode];
  }), [visible, auto, overrides, selected]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) { const { x, y } = change.position; setOverrides((cur) => ({ ...cur, [change.id]: { ...cur[change.id], x, y } })); }
      else if (change.type === "dimensions" && change.setAttributes && change.dimensions) { const { width, height } = change.dimensions; setOverrides((cur) => ({ ...cur, [change.id]: { ...cur[change.id], width, height } })); }
      else if (change.type === "select") setSelected((cur) => { const next = new Set(cur); if (change.selected) next.add(change.id); else next.delete(change.id); return next; });
    }
  }, []);
  const resize = useCallback((id: string, rect: Rect) => setOverrides((cur) => ({ ...cur, [id]: rect })), []);
  return { nodes, visible, onNodesChange, resize, killedCount: agents.filter((agent) => agent.status === "killed").length };
}
