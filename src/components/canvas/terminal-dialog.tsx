import { useEffect, useRef } from "react";
import { IconArrowsMaximize, IconPlayerPlay, IconRefresh, IconX } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ActivityIndicator } from "@/components/agents/activity-indicator";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/agents/provider";
import SessionTerminal, { STATE_DOT } from "@/components/agents/session-terminal";
import { cn } from "cn";
import type { SessionSummary } from "@/lib/runtime/types";

interface Props {
  session: SessionSummary | null;
  waking: boolean;
  onClose: () => void;
  onFullView: (session: SessionSummary) => void;
  onWake: (session: SessionSummary) => void;
  onCloseFocus: () => void;
}

/** Hosts the session's normal interactive SessionTerminal in a large dialog; the canvas mirror pauses while it is open. */
export default function TerminalDialog({ session, waking, onClose, onFullView, onWake, onCloseFocus }: Props) {
  // A sleeping or stopped agent is woken when its terminal is opened (once per open).
  const wokenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!session) { wokenFor.current = null; return; }
    if (wokenFor.current === session.id) return;
    wokenFor.current = session.id;
    if (session.state !== "running" && session.state !== "starting") onWake(session);
  }, [session, onWake]);

  const dormant = !!session && session.state !== "running" && session.state !== "starting";
  return (
    <Dialog open={session !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(780px,88vh)] w-[min(1200px,92vw)] max-w-none flex-col gap-0 overflow-hidden rounded-xl border border-border bg-popover/95 p-0 backdrop-blur-xl sm:max-w-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => { event.preventDefault(); onCloseFocus(); }}
        // Esc belongs to the TUI while the terminal has focus.
        onEscapeKeyDown={(event) => { if ((event.target as HTMLElement | null)?.closest?.(".xterm")) event.preventDefault(); }}
      >
        {session && (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
              <ProviderIcon provider={session.provider} className="size-4" />
              <DialogTitle className="min-w-0 truncate text-sm font-medium" title={session.title}>{session.title}</DialogTitle>
              <DialogDescription className="sr-only">{PROVIDER_LABEL[session.provider]} terminal</DialogDescription>
              <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[session.state])} />
              <Badge variant="outline" className="h-5 shrink-0 text-[10px] font-normal capitalize">{session.state}</Badge>
              <ActivityIndicator session={session} />
              {session.role && <Badge variant="secondary" className="h-5 shrink-0 text-[10px] font-normal">{session.role}</Badge>}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {dormant && (
                  <Button type="button" size="xs" variant="secondary" disabled={waking} onClick={() => onWake(session)}>
                    {waking ? <Spinner /> : session.state === "sleeping" ? <IconPlayerPlay size={12} /> : <IconRefresh size={12} />}
                    {session.state === "sleeping" ? "Wake agent" : "Restart agent"}
                  </Button>
                )}
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Open in full view" title="Open in full view" onClick={() => onFullView(session)}><IconArrowsMaximize size={16} /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)" onClick={onClose}><IconX size={16} /></Button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1 bg-[#0c0c0e]">
              <SessionTerminal key={session.id} sessionId={session.id} active titlebarActions={false} titlebarTitle={false} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
