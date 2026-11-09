import { useEffect, useRef, useState } from "react";
import { Panel } from "@xyflow/react";
import { IconArrowsExchange, IconX } from "@tabler/icons-react";
import type { AgentLink } from "@/lib/runtime/types";

/** How long a cross-project chip stays before it fades out on its own. */
const AUTO_HIDE_MS = 6000;
const FADE_MS = 300;
/** Chips already dismissed (by timer or X) stay hidden for this app session, also across canvas remounts. */
const dismissed = new Set<string>();

/**
 * Wires to agents of OTHER projects. Their node is not on this canvas, so each wire ends in a small
 * "Agent / Project" chip (outgoing = this project's agent reaches out, incoming = a foreign agent wired to it).
 * Chips are transient: each one fades out after a few seconds, and hovering shows an X to close it at once.
 */
export function CrossProjectWires({ links, titleOf }: { links: AgentLink[]; titleOf: (id: string) => string }) {
  const [, setVersion] = useState(0);
  const foreign = links.filter((link) => link.foreign && !dismissed.has(link.id));
  if (!foreign.length) return null;
  const dismiss = (id: string) => { dismissed.add(id); setVersion((v) => v + 1); };
  return (
    <Panel position="top-right" className="m-2! flex max-w-[min(16rem,calc(50%-12px))] flex-col items-end gap-1" aria-label="Cross-project wires">
      {foreign.map((link) => (
        <WireChip key={link.id} link={link} local={titleOf(link.foreign!.direction === "out" ? link.fromSessionId : link.toSessionId)} onDismiss={() => dismiss(link.id)} />
      ))}
    </Panel>
  );
}

function WireChip({ link, local, onDismiss }: { link: AgentLink; local: string; onDismiss: () => void }) {
  const f = link.foreign!;
  const [hovered, setHovered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // Fade out after AUTO_HIDE_MS; hovering pauses the timer so the chip can still be read or closed.
  useEffect(() => {
    if (hovered || leaving) return;
    const timer = setTimeout(() => setLeaving(true), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [hovered, leaving]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => dismissRef.current(), FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <div
      data-slot="cross-project-wire"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${local} ${f.direction === "out" ? "reaches" : "is reached by"} ${f.title} in project ${f.projectName}${link.messageCount ? ` (${link.messageCount} messages)` : ""}`}
      className={`group flex max-w-full items-center gap-1.5 rounded-full border bg-card/90 py-0.5 pr-1 pl-1.5 text-[11px] text-muted-foreground shadow-sm transition-opacity duration-300 motion-reduce:transition-none ${leaving ? "opacity-0" : "opacity-100"}`}
    >
      <IconArrowsExchange aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate"><span className="text-foreground">{local}</span> ↔ {f.title} · {f.projectName}</span>
      <button
        type="button"
        aria-label={`Hide wire to ${f.title}`}
        onClick={() => setLeaving(true)}
        className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      >
        <IconX aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}
