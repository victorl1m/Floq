// "Webhook" entry of the account menu and its dialog: is Floq's webhook in WAHA right (address, signature, every event)? One button repairs it.
import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, DropdownMenuItem, toast } from "@/plugins/kit";
import { errorText, useWa } from "./context";
import { IconCheck } from "./icons";
import { IconSliders } from "./icons-session";
import type { SessionInfo } from "./session-screen";

export type WebhookState = "ok" | "missing" | "missing-events" | "stale" | "unknown";
export interface WebhookHealth { state: WebhookState; missingEvents: string[]; reason?: string; lastEnsuredAt: string | null; lastError?: string; address?: string }
/** The webhook health the runtime reports with the session (absent on a runtime from before 3.2). */
export const healthOf = (info: SessionInfo | null | undefined): WebhookHealth | null => ((info as { webhookHealth?: WebhookHealth } | null | undefined)?.webhookHealth ?? null);

const mono = { fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", fontSize: 12, padding: "2px 6px", borderRadius: 6, background: "color-mix(in srgb, currentColor 10%, transparent)" } as const;
/** Colours are the inbox's theme tokens (ui/theme.ts): the warning tone is the accent, like an unread badge. */
export const WEBHOOK_CSS = `.wa-amenu .wa-wh-warn{color:var(--wa-accent-text)}.wa-amenu .wa-wh-warn svg{color:var(--wa-accent-text)}.wa-whtag{margin-left:auto;width:8px;height:8px;border-radius:50%;background:var(--wa-accent)}`;

/** What is wrong, in words for the person using the inbox. */
export function explainWebhook(h: WebhookHealth): string {
  const n = h.missingEvents.length, some = h.missingEvents.slice(0, 3).join(", ");
  switch (h.state) {
    case "ok": return "WAHA sends this account's messages, delivery ticks and calls to Floq.";
    case "missing": return "WAHA has no webhook to Floq for this session, so new messages and delivery ticks do not arrive.";
    case "missing-events": return `The webhook in WAHA does not send ${n} ${n === 1 ? "event" : "events"} Floq uses (for example ${some}), so some updates, like delivery ticks, do not arrive.`;
    case "stale": return `${h.reason ?? "The webhook in WAHA is out of date."} Floq replaces it and keeps your other webhooks.`;
    default: return /Address WAHA uses/.test(h.reason ?? "")
      ? "Floq does not know its public address yet, so it cannot set the webhook itself. Set “Address WAHA uses to reach Floq” in the plugin settings, then repair."
      : h.reason ?? "Floq cannot check the webhook of this session.";
  }
}

export function WebhookMenuItem({ health, onOpen }: { health: WebhookHealth | null; onOpen(): void }) {
  if (!health) return null;
  const ok = health.state === "ok";
  return (
    <DropdownMenuItem className={ok ? undefined : "wa-wh-warn"} onSelect={onOpen}>
      {ok ? <IconCheck /> : <IconSliders />}{ok ? "Webhook: OK" : "Repair webhook"}{!ok && <span className="wa-whtag" aria-hidden="true" />}
    </DropdownMenuItem>
  );
}

export function WebhookDialog({ open, onOpenChange, health, wantedEvents, refresh }: { open: boolean; onOpenChange(open: boolean): void; health: WebhookHealth | null; wantedEvents?: string[]; refresh(): Promise<unknown> | void }) {
  const { api } = useWa();
  const [busy, setBusy] = useState(false);
  async function repair() {
    setBusy(true);
    try {
      const r = await api<WebhookHealth & { repaired?: boolean }>("/session/webhook-repair", { method: "POST" });
      if (r.state === "ok") toast.success(r.repaired ? "Webhook repaired" : "Webhook is already OK", r.repaired ? { description: "WhatsApp reconnects for a few seconds. Messages are not lost." } : undefined);
      else toast.error("Could not repair the webhook", { description: r.lastError ?? explainWebhook(r) });
      await refresh();
      if (r.state === "ok") onOpenChange(false);
    } catch (e) { toast.error("Could not repair the webhook", { description: errorText(e) }); }
    finally { setBusy(false); }
  }
  if (!health) return null;
  const ok = health.state === "ok";
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{ok ? "Webhook: OK" : "Repair webhook"}</AlertDialogTitle>
          <AlertDialogDescription>
            {explainWebhook(health)}
            {!ok && health.state !== "unknown" && " WAHA restarts the session to apply this, so WhatsApp reconnects for a few seconds. Messages are not lost."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {health.state === "unknown" && !!wantedEvents?.length && (
          <>
            <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>If the webhook is set in WAHA itself, make sure it sends these events (or use *):</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>{wantedEvents.map((e) => <code key={e} style={mono}>{e}</code>)}</div>
          </>
        )}
        {health.lastError && <p style={{ margin: 0, fontSize: 13 }}>Last attempt: {health.lastError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Close</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void repair(); }}>{ok ? "Check again" : "Repair"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
