import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconPlugConnected } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useActiveForwardSession } from "@/components/window/manual-forward-form";
import { portForwardingSupported, startForward, stopForward, usePortForwarding } from "@/lib/port-forwarding";
import { dismissPortRequest, removePortRequest, usePortRequestSync, usePortRequests, type PortRequestItem } from "@/lib/port-requests";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/** Whole seconds left until `deadline`, re-rendered twice a second while mounted and pending. */
function useSecondsLeft(deadline: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [deadline, active]);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Ring plus seconds. Updates in steps (no animation), so it is reduced-motion safe by construction. Hidden from AT; see the status text. */
export function Countdown({ seconds, total }: { seconds: number; total: number }) {
  const fraction = total > 0 ? Math.min(1, seconds / total) : 0;
  return (
    <span aria-hidden="true" data-slot="port-countdown" className="relative inline-flex size-7 shrink-0 items-center justify-center text-[10px] font-medium tabular-nums">
      <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90">
        <circle cx="12" cy="12" r={RING_R} fill="none" strokeWidth="2" className="stroke-border" />
        <circle cx="12" cy="12" r={RING_R} fill="none" strokeWidth="2" strokeLinecap="round" className={seconds <= 10 ? "stroke-destructive" : "stroke-foreground/70"} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - fraction)} />
      </svg>
      <span className="relative">{seconds}</span>
    </span>
  );
}

/** Polite, sparse announcements: once when the request appears, then at 30s and 10s. Never every tick. */
function useAnnouncement(item: PortRequestItem, seconds: number): string {
  const { request } = item;
  const bucket = seconds <= 10 ? 10 : seconds <= 30 ? 30 : 0;
  const key = `${item.state}:${bucket}`;
  const last = useRef({ key: "", text: "" });
  if (last.current.key !== key) {
    const text = item.state === "expired"
      ? `Port request for ${request.port} expired.`
      : bucket === 0
        ? `${request.agentName} asks to open port ${request.port}. Expires in ${Math.round(request.timeoutMs / 1000)} seconds.`
        : `${bucket} seconds left to answer for port ${request.port}.`;
    last.current = { key, text };
  }
  return last.current.text;
}

function describe(item: PortRequestItem): string {
  const { request } = item;
  return `${request.agentName} wants to open ${request.protocol.toUpperCase()} port ${request.port}.`;
}

/** One request with Allow / Deny. Used in the dialog (first request) and in the footer popover (all of them). */
export function PortRequestCard({ item, client, autoFocusDeny = false, onAnswered }: { item: PortRequestItem; client: RuntimeClient | null; autoFocusDeny?: boolean; onAnswered?: () => void }) {
  const { request } = item;
  const expired = item.state === "expired";
  const seconds = useSecondsLeft(item.deadline, !expired);
  const live = useAnnouncement(item, seconds);
  const { forwarded } = usePortForwarding();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = forwarded[request.port];
  const alreadyHere = owner === request.sessionId;
  const blockedBy = !portForwardingSupported
    ? "Opening a port needs the Floq desktop app. You can still deny."
    : owner && !alreadyHere ? `Port ${request.port} is already forwarded from another session.`
    : null;
  const needsAck = request.privileged && !alreadyHere;
  const canAllow = !!client && !expired && !blockedBy && !busy && (!needsAck || understood);

  async function answer(decision: "allow" | "deny") {
    if (!client || busy) return;
    setBusy(decision);
    setError(null);
    try {
      if (decision === "deny") {
        await client.resolvePortRequest(request.id, { decision: "deny" });
        removePortRequest(request.id);
        onAnswered?.();
        return;
      }
      let opened = false;
      if (!alreadyHere) {
        try {
          // Ports below 1024 can only be tunnelled when the session really listens on them (no manual mode).
          await startForward(client, request.sessionId, request.port, request.port >= 1024);
          opened = true;
        } catch (failure) {
          await client.resolvePortRequest(request.id, { decision: "error", message: errorMessage(failure) }).catch(() => undefined);
          removePortRequest(request.id);
          toast.error(`Could not open port ${request.port}`, { description: errorMessage(failure) });
          onAnswered?.();
          return;
        }
      }
      try {
        await client.resolvePortRequest(request.id, { decision: "allow" });
      } catch {
        // The runtime already ended the request (timeout, agent gone): undo what we opened.
        if (opened) await stopForward(request.port);
        setError(`This request already expired, so port ${request.port} was not opened.`);
        return;
      }
      removePortRequest(request.id);
      toast.success(`Forwarding localhost:${request.port}`, { description: "Open it in a browser on this computer." });
      onAnswered?.();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-slot="port-request" data-state={item.state} className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><IconPlugConnected size={16} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-pretty">{describe(item)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>Agent</dt><dd className="truncate text-foreground">{request.agentName}</dd>
            <dt>Port</dt><dd className="text-foreground tabular-nums">{request.port} ({request.protocol.toUpperCase()}) to localhost:{request.port}</dd>
            {request.purpose && (<><dt>Purpose</dt><dd className="text-pretty text-foreground">{request.purpose}</dd></>)}
          </dl>
        </div>
        {expired ? <span className="shrink-0 text-xs text-muted-foreground">Expired</span> : <Countdown seconds={seconds} total={Math.round(request.timeoutMs / 1000)} />}
      </div>
      {!expired && <p className="text-xs text-muted-foreground tabular-nums">{seconds}s left. No answer cancels the request.</p>}
      {request.privileged && (
        <p className="flex items-start gap-1.5 text-xs"><IconAlertTriangle size={14} className="mt-px shrink-0 text-destructive" aria-hidden="true" />Privileged port (below 1024), normally reserved for system services.</p>
      )}
      {needsAck && !expired && (
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={understood} onCheckedChange={(value) => setUnderstood(value === true)} />I understand this is a privileged port</label>
      )}
      {blockedBy && !expired && <p className="text-xs text-muted-foreground">{blockedBy}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        {expired ? (
          <Button type="button" variant="outline" size="sm" onClick={() => { removePortRequest(request.id); onAnswered?.(); }}>Dismiss</Button>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" data-autofocus={autoFocusDeny ? "" : undefined} disabled={!client || !!busy} onClick={() => void answer("deny")}>Deny</Button>
            <Button type="button" size="sm" disabled={!canAllow} onClick={() => void answer("allow")}>{busy === "allow" ? "Opening..." : "Allow"}</Button>
          </>
        )}
      </div>
      <span role="status" aria-live="polite" className="sr-only">{live}</span>
    </div>
  );
}

/** Mounted once at the app root: syncs requests and shows the first unanswered one in a dialog. */
export function PortRequestHost() {
  const { client } = useActiveForwardSession();
  usePortRequestSync(client);
  const items = usePortRequests();
  const current = items.find((item) => !item.dismissed);
  const body = useRef<HTMLDivElement>(null);
  if (!current) return null;
  const waiting = items.filter((item) => item.request.id !== current.request.id && item.state === "pending").length;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismissPortRequest(current.request.id); }}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Land on Deny: a stray Enter or Space while typing in the terminal must never grant access.
          event.preventDefault();
          body.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Open a port?</DialogTitle>
          <DialogDescription>An agent is asking to reach a port from this computer. Nothing is opened unless you allow it.{waiting > 0 ? ` ${waiting} more waiting.` : ""}</DialogDescription>
        </DialogHeader>
        <div ref={body}><PortRequestCard key={current.request.id} item={current} client={client} autoFocusDeny /></div>
        <DialogFooter className="bg-transparent text-xs text-muted-foreground sm:justify-start">
          <span>Esc decides later from Network in the footer.</span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
