export type UserRole = "admin" | "member";
export type UpdateTarget = "runtime" | "claude" | "codex" | "whatsapp";

export interface AdminUser { id: string; name: string; email: string; role: UserRole; createdAt: string; lastActiveAt: string | null }

export interface UpdateItem {
  target: UpdateTarget;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  source: string;
  error?: string;
  /** whatsapp only: false = an external server, updated where it is hosted. */
  managed?: boolean;
}

export interface UpdatesStatus { items: UpdateItem[]; checkedAt: string; activeSessions: number; applying: UpdateTarget | null }
export type WhatsappServerState = "off" | "starting" | "unreachable" | "unauthorized" | "running";
export interface WhatsappServerStatus {
  builtin: { enabled: boolean; state: WhatsappServerState; version: string | null; engine: string | null; tier: string | null; image: string | null; managed: boolean; error?: string };
  plugin: { installed: boolean; enabled: boolean; mode: "builtin" | "external" | "none" };
  autoUpdate: { enabled: boolean; quietMinutes: number; lastCheckAt: string | null; last: { at: string; ok: boolean; from: string | null; to: string | null; rolledBack: boolean; message: string } | null };
  checkedAt: string;
}
export interface WhatsappServerHealth { ok: boolean; state: WhatsappServerState; latencyMs: number | null; version: string | null; checkedAt: string }
export interface WhatsappServerTest { ok: boolean; state: "running" | "unreachable" | "unauthorized"; version: string | null; engine: string | null; error?: string }
export interface UpdateResult { target: UpdateTarget; ok: boolean; restarting: boolean; log: string; activeSessions: number }
