// Pure rules of Settings > Integrations. Relative imports only (runs under plain node tests).
import type { WhatsappServerStatus } from "../../lib/runtime/admin-types";
import type { PluginInfo } from "../../lib/runtime/types";

export type ServerMode = "builtin" | "external" | "none";
export type Tone = "ok" | "warn" | "bad" | "off";

/** What `GET /session` and `GET /accounts` of the integration answer (the parts shown here). */
export interface WaSession { status: string; engine?: string; me?: { name?: string; phone?: string } | null; webhook?: { configured: boolean; events: string[]; missingEvents: string[] } | null; webhookHealth?: { state: "ok" | "missing" | "missing-events" | "stale" | "unknown"; missingEvents: string[]; reason?: string } | null }
export interface WaAccount { session: string; label?: string; name?: string; phone?: string | null; primary?: boolean; status: string; unread?: number }

/**
 * Which WhatsApp (WAHA) server the integration would use. A saved address always wins (external); otherwise the server compose runs beside
 * Floq, when there is one. "none": the integration cannot be turned on and the card explains how to get a server.
 */
export function serverMode(server: Pick<WhatsappServerStatus, "builtin" | "plugin"> | null, plugin: Pick<PluginInfo, "integration"> | undefined, savedAddress: string): ServerMode {
  if (server) return server.plugin.mode === "external" ? "external" : server.builtin.enabled ? "builtin" : savedAddress.trim() ? "external" : "none";
  // A runtime without the server status route: go by what the plugin list and the saved address say.
  if (savedAddress.trim()) return "external";
  return plugin?.integration?.active ? "builtin" : "none";
}

const STATUS: Record<string, { text: string; tone: Tone }> = {
  WORKING: { text: "Connected", tone: "ok" },
  SCAN_QR_CODE: { text: "Waiting for the QR code scan", tone: "warn" },
  STARTING: { text: "Starting", tone: "warn" },
  STOPPED: { text: "Stopped", tone: "off" },
  FAILED: { text: "Failed", tone: "bad" },
  MISSING: { text: "No account linked yet", tone: "off" },
  UNREACHABLE: { text: "The WhatsApp server cannot be reached", tone: "bad" },
  UNAUTHORIZED: { text: "The WhatsApp server refused the API key", tone: "bad" },
};
export const statusOf = (status: string) => STATUS[status] ?? { text: status ? status.toLowerCase().replace(/_/g, " ") : "Unknown", tone: "off" as Tone };

export function connectionOf(s: WaSession): { text: string; tone: Tone } {
  const base = statusOf(s.status);
  if (s.status !== "WORKING") return base;
  const who = [s.me?.name, s.me?.phone ? "+" + String(s.me.phone).replace(/^\+/, "") : ""].filter(Boolean).join(", ");
  return { text: who ? `Connected as ${who}` : "Connected", tone: "ok" };
}

export function accountLine(a: WaAccount): string {
  const name = a.label || a.name || a.session;
  const phone = a.phone ? ` (+${String(a.phone).replace(/^\+/, "")})` : "";
  const unread = a.unread ? `, ${a.unread} unread` : "";
  return `${name}${phone}: ${statusOf(a.status).text.toLowerCase()}${unread}`;
}

/** Whether WAHA is set up to deliver events to Floq (the session's webhook), in words. */
export function webhookLine(s: WaSession): { text: string; tone: Tone; repair?: boolean } {
  if (["MISSING", "UNREACHABLE", "UNAUTHORIZED"].includes(s.status)) return { text: "Not checked yet", tone: "off" };
  // Floq sets and repairs the webhook itself; this is what its last check found.
  const h = s.webhookHealth;
  if (h) {
    const n = h.missingEvents.length;
    switch (h.state) {
      case "ok": return { text: "Webhook delivering every event", tone: "ok" };
      case "missing": return { text: "The WhatsApp server has no webhook to Floq: new messages will not arrive", tone: "bad", repair: true };
      case "missing-events": return { text: `Webhook set, ${n} event type${n === 1 ? "" : "s"} missing`, tone: "warn", repair: true };
      case "stale": return { text: h.reason ?? "The webhook on the WhatsApp server is out of date", tone: "warn", repair: true };
      default: return { text: h.reason ?? "Floq cannot check the webhook of this account", tone: "off", repair: true };
    }
  }
  if (!s.webhook?.configured) return { text: "No webhook found on the WhatsApp server: new messages will not arrive", tone: "bad" };
  const missing = s.webhook.missingEvents.length;
  return missing ? { text: `Webhook set, ${missing} event type${missing === 1 ? "" : "s"} missing (fix it from the WhatsApp view)`, tone: "warn" } : { text: "Webhook delivering every event", tone: "ok" };
}
