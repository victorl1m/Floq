import { IconArrowRight, IconChevronDown, IconFilterOff, IconMessage, IconRoute, IconSend, IconX } from "@tabler/icons-react";
import { formatDistanceToNowStrict } from "date-fns";
import { Button } from "@/components/ui/button";
import type { AgentMessageEvent } from "./canvas-data";

const KIND_ICON = { ask: IconSend, reply: IconMessage, recruit: IconRoute } as const;
const KIND_TEXT = { ask: "asked", reply: "replied to", recruit: "recruited" } as const;

function ago(at: string): string {
  const time = Date.parse(at);
  return Number.isFinite(time) ? formatDistanceToNowStrict(time, { addSuffix: true }) : "";
}

export default function ActivityPanel({ events, titleOf, filterLinkId, onClearFilter, onSelect, onClose }: {
  events: AgentMessageEvent[];
  titleOf: (id: string) => string;
  filterLinkId: string | null;
  onClearFilter: () => void;
  onSelect: (event: AgentMessageEvent) => void;
  onClose: () => void;
}) {
  const shown = filterLinkId ? events.filter((event) => event.linkId === filterLinkId) : events;
  return (
    <div className="absolute bottom-16 left-3 z-10 flex max-h-56 w-64 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-lg">
      <div className="flex items-center gap-1 border-b px-2.5 py-1.5">
        <IconChevronDown size={12} className="text-muted-foreground" />
        <span className="text-xs font-medium">Activity</span>
        {filterLinkId && (
          <Button type="button" variant="ghost" size="xs" className="ml-1" onClick={onClearFilter} title="Show all wires">
            <IconFilterOff size={12} />
            This wire
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close activity" onClick={onClose}><IconX size={12} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="p-3 text-xs text-muted-foreground">No agent-to-agent messages yet. Delegations and asks show up here.</p>}
        {shown.map((event) => {
          const Icon = KIND_ICON[event.kind] ?? IconMessage;
          return (
            <button key={`${event.linkId}${event.at}${event.kind}${event.preview.slice(0, 20)}`} type="button" onClick={() => onSelect(event)} className="flex w-full flex-col gap-0.5 border-b px-2.5 py-1.5 text-left last:border-b-0 hover:bg-muted/60">
              <span className="flex items-center gap-1 text-[11px]">
                <Icon size={11} className="shrink-0 text-muted-foreground" />
                <span className="max-w-24 truncate font-medium">{titleOf(event.fromSessionId)}</span>
                <IconArrowRight size={10} className="shrink-0 text-muted-foreground" />
                <span className="max-w-24 truncate font-medium">{titleOf(event.toSessionId)}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{ago(event.at)}</span>
              </span>
              <span className="line-clamp-2 text-[11px] break-words text-muted-foreground">{KIND_TEXT[event.kind]}: {event.preview}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
