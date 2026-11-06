// Keychain nodes (a wallet of secrets), their amber wires to agents, and the hook that syncs them with the runtime.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, BaseEdge, EdgeLabelRenderer, Handle, NodeResizer, Position, useNodesState, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { IconKey, IconLock, IconPlus, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import {
  createKeychainRequest, deleteKeychainRequest, fetchKeychains, linkKeychain, unlinkKeychain, updateKeychainRequest,
  type Keychain, type KeychainPatch, type KeychainSecret, type NoteColor,
} from "./canvas-data";
import { COLORS, COLOR_KEYS } from "./canvas-notes";
import { pathOf, RESIZER_ABOVE, route, SIDE_STRIP_CLASS, SIDE_STRIP_STYLE, useRect } from "./wire-edge";

export const KC_PREFIX = "kc:";
export const KCLINK_PREFIX = "kclink:";
export const isKeychainId = (id: string) => id.startsWith(KC_PREFIX);
export const isKeychainLinkId = (id: string) => id.startsWith(KCLINK_PREFIX);
export const kcLinkId = (keychainId: string, sessionId: string) => `${KCLINK_PREFIX}${keychainId}:${sessionId}`;
export const KC_MIN = { width: 200, height: 110 };
export const KC_DEFAULT = { width: 240, height: 150 };
export const KC_AMBER = "#f59e0b";
export const AUTO_NAME = "Keychain";

export type KeychainNode = Node<{ keychain: Keychain }, "keychain">;
export type KeychainWireEdge = Edge<{ keychainId: string; sessionId: string; name: string }, "keychain-wire">;

const toNode = (keychain: Keychain): KeychainNode => ({
  id: KC_PREFIX + keychain.id,
  type: "keychain",
  position: { x: keychain.x, y: keychain.y },
  width: keychain.w ?? KC_DEFAULT.width,
  height: keychain.h ?? KC_DEFAULT.height,
  dragHandle: ".kc-drag",
  data: { keychain },
});

interface KeychainCtxValue {
  patch: (id: string, patch: KeychainPatch) => void;
  manage: (id: string) => void;
  setEditing: (id: string, editing: boolean) => void;
  renamingId: string | null;
  clearRenaming: () => void;
  isNew: (id: string) => boolean;
  titleOf: (sessionId: string) => string;
}
// Inert default so a card rendered outside (or out of sync with) its provider degrades instead of crashing the canvas.
const KeychainCtx = createContext<KeychainCtxValue>({ patch: () => {}, manage: () => {}, setEditing: () => {}, renamingId: null, clearRenaming: () => {}, isNew: () => false, titleOf: () => "agent" });
export const KeychainProvider = KeychainCtx.Provider;

const heightOf = (h: number | null | undefined) => h ?? KC_DEFAULT.height;

const RECENT_MS = 30_000;
const relTime = (iso: string, now: number) => {
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};
/** Secrets with usage info; falls back to bare names when the runtime sent none. */
const secretsOf = (kc: Keychain): KeychainSecret[] => kc.secrets ?? kc.secretNames.map((name) => ({ name, createdBy: null, lastUsedAt: null, lastUsedBy: null, uses: 0 }));

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

const KeychainCard = memo(function KeychainCard({ data, selected }: NodeProps<KeychainNode>) {
  const ctx = useContext(KeychainCtx);
  const kc = data.keychain;
  const connecting = useConnection().inProgress;
  const palette = COLORS[kc.color] ?? COLORS.yellow;
  const [name, setName] = useState(kc.name);
  const editing = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing.current) setName(kc.name); }, [kc.name]);
  useEffect(() => {
    if (ctx.renamingId === kc.id || ctx.isNew(kc.id)) { inputRef.current?.focus(); inputRef.current?.select(); ctx.clearRenaming(); }
  }, [ctx, kc.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    editing.current = false;
    ctx.setEditing(kc.id, false);
    const next = name.trim();
    if (!next) { setName(kc.name); return; }
    if (next !== kc.name) ctx.patch(kc.id, { name: next });
  };
  const count = kc.secretNames.length;
  const linked = kc.linkedSessionIds.length;
  // Show as many name rows as the card height fits (header 32 + footer ~40 + padding).
  const rows = Math.max(1, Math.floor(((heightOf(kc.h)) - 96) / 40));
  const secrets = secretsOf(kc);
  const shown = secrets.slice(0, count > rows ? Math.max(1, rows - 1) : rows);
  // Re-render every few seconds so relative times and the "just used" pulse stay current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);

  return (
    <div className="group/kc relative size-full">
      <NodeResizer
        isVisible={selected}
        minWidth={KC_MIN.width}
        minHeight={KC_MIN.height}
        onResizeStart={() => ctx.setEditing(kc.id, true)}
        onResizeEnd={(_, rect) => { ctx.patch(kc.id, { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }); ctx.setEditing(kc.id, false); }}
        lineStyle={RESIZER_ABOVE}
        handleStyle={RESIZER_ABOVE}
        lineClassName="border-amber-500/70! after:absolute after:-inset-1 after:content-['']"
        handleClassName="size-3! rounded-sm! border-2! border-amber-500! bg-background! after:absolute after:-inset-1 after:content-['']"
      />
      {SIDES.map((position) => (
        <Handle key={position} id={position} type="source" position={position} isConnectable isConnectableStart isConnectableEnd
          style={SIDE_STRIP_STYLE[position]}
          className={SIDE_STRIP_CLASS} />
      ))}
      <div className={cn("relative flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow", palette.border, selected && "border-amber-500/70 shadow-md ring-2 ring-amber-500/30", "peer-hover/h:ring-2 peer-hover/h:ring-amber-500/60 peer-hover/h:shadow-[0_0_16px_0_var(--color-amber-500)]", connecting && "group-hover/kc:border-emerald-500 group-hover/kc:ring-2 group-hover/kc:ring-emerald-500/50 group-hover/kc:shadow-[0_0_16px_0_var(--color-emerald-500)]")}>
        <div aria-hidden className={cn("pointer-events-none absolute inset-0", palette.tint)} />
        <div className={cn("kc-drag relative flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b px-2 active:cursor-grabbing", palette.border)}>
          <IconLock size={14} className="shrink-0 text-amber-500" aria-hidden="true" />
          <input
            ref={inputRef}
            value={name}
            maxLength={80}
            spellCheck={false}
            aria-label="Keychain name"
            onChange={(event) => setName(event.target.value)}
            onFocus={() => { editing.current = true; ctx.setEditing(kc.id, true); }}
            onBlur={commit}
            onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setName(kc.name); event.currentTarget.blur(); } }}
            className="nodrag nopan min-w-0 flex-1 truncate bg-transparent text-[13px] font-medium outline-none focus:underline"
          />
          <span className="shrink-0 rounded-full bg-muted/70 px-1.5 text-[10px] text-muted-foreground tabular-nums" title={`${count} secret${count === 1 ? "" : "s"}`}>{count}</span>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="nodrag nopan flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10" aria-label="Keychain color" title="Color">
                <span className={cn("size-3 rounded-full", palette.dot)} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="flex w-auto gap-1.5 p-2" side="bottom" align="end">
              {COLOR_KEYS.map((key: NoteColor) => (
                <button key={key} type="button" aria-label={COLORS[key].label} title={COLORS[key].label} onClick={() => ctx.patch(kc.id, { color: key })}
                  className={cn("size-5 rounded-full ring-offset-2 ring-offset-popover", COLORS[key].dot, kc.color === key && "ring-2 ring-foreground/60")} />
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col gap-1.5 p-2" onClick={() => ctx.manage(kc.id)}>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
            {shown.map((secret) => {
              const recent = !!secret.lastUsedAt && now - new Date(secret.lastUsedAt).getTime() < RECENT_MS;
              const usedLine = secret.lastUsedAt
                ? `used by ${secret.lastUsedBy ? ctx.titleOf(secret.lastUsedBy) : "an agent"} · ${relTime(secret.lastUsedAt, now)} · ${secret.uses}×`
                : "never used";
              return (
                <div key={secret.name} className={cn("flex min-w-0 flex-col rounded-md border bg-background/60 px-1.5 py-0.5 transition-shadow", recent && "animate-pulse border-amber-500 shadow-[0_0_10px_0_var(--color-amber-500)]")} title={[secret.name, usedLine, secret.createdBy ? `added by ${ctx.titleOf(secret.createdBy)}` : ""].filter(Boolean).join("\n")}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <IconKey size={11} className="shrink-0 text-amber-500" aria-hidden="true" />
                    <span className="min-w-0 truncate font-mono text-[11px]">{secret.name}</span>
                  </div>
                  <span className={cn("truncate pl-4 text-[10px] leading-tight", secret.lastUsedAt ? "text-foreground/70" : "text-muted-foreground")}>{usedLine}</span>
                  {secret.createdBy && <span className="truncate pl-4 text-[10px] leading-tight text-muted-foreground">added by {ctx.titleOf(secret.createdBy)}</span>}
                </div>
              );
            })}
            {count > shown.length && <span className="px-1 text-[10px] text-muted-foreground">+{count - shown.length} more</span>}
            {count === 0 && <span className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">No secrets yet</span>}
          </div>
          <div className="flex items-center gap-2 border-t border-border/60 pt-1.5">
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground tabular-nums" title={`Linked to ${linked} agent${linked === 1 ? "" : "s"}`}>{linked} agent{linked === 1 ? "" : "s"} linked</span>
            <Button type="button" variant="secondary" size="xs" className="nodrag nopan h-6 shrink-0 text-[11px]" onClick={(event) => { event.stopPropagation(); ctx.manage(kc.id); }}>
              <IconPlus size={12} />Manage
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

export const keychainNodeTypes = { keychain: KeychainCard };

/** Amber, dashed wire from a keychain to an agent; arrow toward the agent, small key pill, unlink button when selected. */
export const KeychainWireEdgeView = memo(function KeychainWireEdgeView({ id, source, target, data, selected, markerEnd }: EdgeProps<KeychainWireEdge>) {
  const ctx = useContext(KeychainWireCtx);
  const from = useRect(source);
  const to = useRect(target);
  const geometry = useMemo(() => {
    if (!from || !to) return null;
    const curve = route(from, to, [], 0);
    const t = 0.5, u = 0.5;
    const mid = {
      x: u * u * u * curve.a.x + 3 * u * u * t * curve.c1.x + 3 * u * t * t * curve.c2.x + t * t * t * curve.b.x,
      y: u * u * u * curve.a.y + 3 * u * u * t * curve.c1.y + 3 * u * t * t * curve.c2.y + t * t * t * curve.b.y,
    };
    return { path: pathOf(curve), mid };
  }, [from, to]);
  if (!data || !geometry) return null;
  return (
    <>
      <BaseEdge id={id} path={geometry.path} markerEnd={markerEnd} interactionWidth={28}
        style={{ stroke: KC_AMBER, strokeWidth: selected ? 3 : 2, strokeDasharray: "9 4 2 4", opacity: selected ? 1 : 0.85 }} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan absolute" style={{ transform: `translate(-50%, -50%) translate(${geometry.mid.x}px, ${geometry.mid.y}px)`, pointerEvents: "all" }}>
          <div className={cn("flex items-center gap-1 rounded-full border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm", selected ? "border-amber-500" : "border-border")} title={`Keychain ${data.name} → agent`}>
            <IconKey size={11} style={{ color: KC_AMBER }} />
            <IconLock size={10} />
            {selected && (
              <Button variant="ghost" size="icon-xs" type="button" aria-label="Unlink keychain" title="Unlink (Del)" className="ml-0.5 size-4 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={(event) => { event.stopPropagation(); ctx?.unlink(data.keychainId, data.sessionId); }}>
                <IconX size={11} />
              </Button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
export const KeychainWireCtx = createContext<{ unlink: (keychainId: string, sessionId: string) => void } | null>(null);
export const keychainEdgeTypes = { "keychain-wire": KeychainWireEdgeView };

const sameKeychain = (a: Keychain, b: Keychain) =>
  a.name === b.name && a.color === b.color && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
  a.secretNames.join("\n") === b.secretNames.join("\n") && JSON.stringify(a.secrets ?? null) === JSON.stringify(b.secrets ?? null) && a.linkedSessionIds.join("\n") === b.linkedSessionIds.join("\n");

/** Keychains of one project: polled every 5s, optimistic edits with rollback, never clobbering one being edited or dragged. */
export function useCanvasKeychains(client: RuntimeClient | null, projectId: string | null, titleOf: (sessionId: string) => string) {
  const [nodes, setNodes, onNodesChange] = useNodesState<KeychainNode>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const titleOfRef = useRef(titleOf);
  titleOfRef.current = titleOf;
  const editing = useRef(new Set<string>());
  const pending = useRef(new Map<string, number>());
  const created = useRef(new Map<string, number>());
  const newId = useRef<string | null>(null);
  /** Ids deleted locally: an in-flight poll that began before the delete must not resurrect them. */
  const deleted = useRef(new Set<string>());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);

  const setEditing = useCallback((id: string, on: boolean) => { if (on) editing.current.add(id); else editing.current.delete(id); }, []);
  const isBusy = (id: string) => editing.current.has(id) || (pending.current.get(id) ?? 0) > 0;
  const track = <T,>(id: string, promise: Promise<T>) => {
    pending.current.set(id, (pending.current.get(id) ?? 0) + 1);
    return promise.finally(() => {
      const left = (pending.current.get(id) ?? 1) - 1;
      if (left > 0) pending.current.set(id, left); else pending.current.delete(id);
    });
  };

  const refresh = useCallback(async () => {
    if (!client || !projectId) return;
    let server: Keychain[];
    try { server = await fetchKeychains(client, projectId); } catch { return; }
    server = server.filter((kc) => !deleted.current.has(kc.id));
    // Announce secrets an agent pulled since the last poll (never on first load: only keychains we already hold).
    for (const kc of server) {
      const before = nodesRef.current.find((node) => node.data.keychain.id === kc.id)?.data.keychain;
      if (!before) continue;
      const was = new Map(secretsOf(before).map((secret) => [secret.name, secret.lastUsedAt]));
      for (const secret of secretsOf(kc)) {
        if (secret.lastUsedAt && was.has(secret.name) && was.get(secret.name) !== secret.lastUsedAt) {
          toast(`${secret.lastUsedBy ? titleOfRef.current(secret.lastUsedBy) : "An agent"} used ${secret.name} from ${kc.name}`);
        }
      }
    }
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.data.keychain.id, node]));
      const next: KeychainNode[] = server.map((kc) => {
        const existing = byId.get(kc.id);
        if (!existing) return toNode(kc);
        if (isBusy(kc.id) || sameKeychain(existing.data.keychain, kc)) return existing;
        return { ...existing, position: { x: kc.x, y: kc.y }, width: kc.w ?? existing.width ?? KC_DEFAULT.width, height: kc.h ?? existing.height ?? KC_DEFAULT.height, data: { keychain: kc } };
      });
      const have = new Set(server.map((kc) => kc.id));
      for (const node of current) {
        const id = node.data.keychain.id;
        if (!have.has(id) && Date.now() - (created.current.get(id) ?? 0) < 10_000) next.push(node);
      }
      return next;
    });
  }, [client, projectId, setNodes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setNodes([]);
    editing.current.clear();
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh, setNodes]);

  const apply = useCallback((id: string, change: Partial<Keychain>) => setNodes((current) => current.map((node) => {
    if (node.data.keychain.id !== id) return node;
    const kc = { ...node.data.keychain, ...change };
    return { ...node, position: { x: kc.x, y: kc.y }, width: kc.w ?? node.width, height: kc.h ?? node.height, data: { keychain: kc } };
  })), [setNodes]);

  const patch = useCallback((id: string, change: KeychainPatch) => {
    if (!client) return;
    const before = nodesRef.current.find((node) => node.data.keychain.id === id)?.data.keychain;
    if (!before) return;
    apply(id, change);
    track(id, updateKeychainRequest(client, id, change)).catch((error) => {
      const revert: Partial<Keychain> = {};
      for (const key of Object.keys(change) as (keyof KeychainPatch)[]) Object.assign(revert, { [key]: before[key] });
      apply(id, revert);
      toast.error("Could not save the keychain", { description: errorMessage(error) });
    });
  }, [client, apply]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = useCallback(async (input: { x: number; y: number }) => {
    if (!client || !projectId) return;
    try {
      const kc = await createKeychainRequest(client, projectId, { name: AUTO_NAME, w: KC_DEFAULT.width, h: KC_DEFAULT.height, color: "yellow", ...input });
      created.current.set(kc.id, Date.now());
      newId.current = kc.id;
      setNodes((current) => [...current.filter((node) => node.data.keychain.id !== kc.id), { ...toNode(kc), selected: true }]);
    } catch (error) {
      toast.error("Could not add the keychain", { description: errorMessage(error) });
    }
  }, [client, projectId, setNodes]);

  /** Destroys the keychain and its secrets; callers confirm first. */
  const remove = useCallback((id: string) => {
    if (!client) return;
    const gone = nodesRef.current.find((node) => node.data.keychain.id === id);
    if (!gone) return; // already removed: guards double-delete
    deleted.current.add(id);
    setNodes((current) => current.filter((node) => node.data.keychain.id !== id));
    setManaging((current) => (current === id ? null : current));
    deleteKeychainRequest(client, id).then(() => toast.success("Keychain deleted", { description: "Agents linked to it can no longer read its secrets." })).catch((error) => {
      deleted.current.delete(id);
      if (gone) setNodes((current) => [...current.filter((node) => node.data.keychain.id !== id), gone]);
      toast.error("Could not delete the keychain", { description: errorMessage(error) });
    });
  }, [client, setNodes]);

  const link = useCallback((id: string, sessionId: string) => {
    if (!client) return;
    const kc = nodesRef.current.find((node) => node.data.keychain.id === id)?.data.keychain;
    if (!kc) return;
    if (kc.linkedSessionIds.includes(sessionId)) { toast.info("Already linked", { description: `${kc.name} is linked to ${titleOf(sessionId)}.` }); return; }
    const before = kc.linkedSessionIds;
    apply(id, { linkedSessionIds: [...before, sessionId] });
    track(id, linkKeychain(client, id, sessionId)).then(() => {
      toast.success(`${kc.name} linked to ${titleOf(sessionId)}`, {
        description: "The agent can now read its secrets with floq secret get NAME.",
      });
    }).catch((error) => {
      apply(id, { linkedSessionIds: before });
      toast.error("Could not link the keychain", { description: errorMessage(error) });
    });
  }, [client, apply, titleOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlink = useCallback((id: string, sessionId: string) => {
    if (!client) return;
    const kc = nodesRef.current.find((node) => node.data.keychain.id === id)?.data.keychain;
    if (!kc) return;
    const before = kc.linkedSessionIds;
    apply(id, { linkedSessionIds: before.filter((item) => item !== sessionId) });
    track(id, unlinkKeychain(client, id, sessionId)).catch((error) => {
      apply(id, { linkedSessionIds: before });
      toast.error("Could not unlink the keychain", { description: errorMessage(error) });
    });
  }, [client, apply]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxValue = useMemo<KeychainCtxValue>(() => ({
    patch,
    manage: setManaging,
    setEditing,
    renamingId,
    clearRenaming: () => setRenamingId(null),
    isNew: (id) => { if (newId.current !== id) return false; newId.current = null; return true; },
    titleOf: (sessionId) => titleOfRef.current(sessionId),
  }), [patch, setEditing, renamingId]);

  const dragStart = useCallback((node: Node) => setEditing(node.id.slice(KC_PREFIX.length), true), [setEditing]);
  const dragEnd = useCallback((node: Node) => {
    const id = node.id.slice(KC_PREFIX.length);
    patch(id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
    setEditing(id, false);
  }, [patch, setEditing]);

  const keychains = useMemo(() => nodes.map((node) => node.data.keychain), [nodes]);
  return {
    nodes, keychains, onNodesChange: onNodesChange as (changes: NodeChange<Node>[]) => void,
    add, remove, link, unlink, patch, ctxValue, dragStart, dragEnd, refresh,
    managing, setManaging, rename: (id: string) => setRenamingId(id),
  };
}
