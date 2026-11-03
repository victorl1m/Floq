export type UserRole = "admin" | "member";
export type UpdateTarget = "runtime" | "claude" | "codex";

export interface AdminUser { id: string; name: string; email: string; role: UserRole; createdAt: string; lastActiveAt: string | null }

export interface UpdateItem {
  target: UpdateTarget;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  source: string;
  error?: string;
}

export interface UpdatesStatus { items: UpdateItem[]; checkedAt: string; activeSessions: number; applying: UpdateTarget | null }
export interface UpdateResult { target: UpdateTarget; ok: boolean; restarting: boolean; log: string; activeSessions: number }
