import { Panel } from "@xyflow/react";
import { IconArrowsExchange } from "@tabler/icons-react";
import type { AgentLink } from "@/lib/runtime/types";

/**
 * Wires to agents of OTHER projects. Their node is not on this canvas, so each wire ends in a small
 * "Agent / Project" chip (outgoing = this project's agent reaches out, incoming = a foreign agent wired to it).
 */
export function CrossProjectWires({ links, titleOf }: { links: AgentLink[]; titleOf: (id: string) => string }) {
  const foreign = links.filter((link) => link.foreign);
  if (!foreign.length) return null;
  return (
    <Panel position="top-right" className="m-2! mt-14! flex max-w-64 flex-col items-end gap-1" aria-label="Cross-project wires">
      {foreign.map((link) => {
        const f = link.foreign!;
        const local = titleOf(f.direction === "out" ? link.fromSessionId : link.toSessionId);
        return (
          <div
            key={link.id}
            data-slot="cross-project-wire"
            title={`${local} ${f.direction === "out" ? "reaches" : "is reached by"} ${f.title} in project ${f.projectName}${link.messageCount ? ` (${link.messageCount} messages)` : ""}`}
            className="flex max-w-full items-center gap-1.5 rounded-full border bg-card/90 py-0.5 pr-2 pl-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm"
          >
            <IconArrowsExchange aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate"><span className="text-foreground">{local}</span> ↔ {f.title} · {f.projectName}</span>
          </div>
        );
      })}
    </Panel>
  );
}
