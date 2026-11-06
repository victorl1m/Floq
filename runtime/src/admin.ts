import type pg from "pg";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { log } from "./logger.js";

/** Instance-level roles, stored in collaboration.user_roles. No row means "member". */
export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

type Db = Pick<pg.Pool, "query">;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface AdminUser { id: string; name: string; email: string; role: Role; createdAt: string; lastActiveAt: string | null }

/** Pure rule: demoting an administrator is refused when they are the only one left. */
export function assertRoleChangeAllowed(currentRole: Role, nextRole: Role, adminCount: number): void {
  if (currentRole === "admin" && nextRole !== "admin" && adminCount <= 1) {
    throw conflict("At least one administrator is required. Promote someone else first.", "last_admin");
  }
}

export function requireRoleValue(value: unknown): Role {
  if (!isRole(value)) throw badRequest(`role must be one of: ${ROLES.join(", ")}`, "invalid_role");
  return value;
}

/**
 * Bootstrap only: when no administrator exists yet, promote the configured bootstrap email (or, when none is
 * configured, the earliest registered user). After that the database is the single source of truth.
 */
async function ensureAdminExists(db: Db, bootstrapEmail: string | null): Promise<void> {
  const existing = await db.query("SELECT 1 FROM collaboration.user_roles WHERE role = 'admin' LIMIT 1");
  if (existing.rowCount) return;
  // With a configured bootstrap email only that account may become the first admin: never the earliest registrant.
  const picked = bootstrapEmail
    ? await db.query('SELECT id FROM public."user" WHERE lower(email) = $1 LIMIT 1', [bootstrapEmail.toLowerCase()])
    : await db.query('SELECT id FROM public."user" ORDER BY "createdAt" ASC LIMIT 1');
  const id = picked.rows[0]?.id as string | undefined;
  if (!id) return;
  const res = await db.query(
    `INSERT INTO collaboration.user_roles (user_id, role) SELECT $1, 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM collaboration.user_roles WHERE role = 'admin')
     ON CONFLICT (user_id) DO UPDATE SET role = 'admin', updated_at = now()`,
    [id],
  );
  if (res.rowCount) log.info("admin.bootstrap", { userId: id });
}

export async function getRole(db: Db, bootstrapEmail: string | null, userId: string): Promise<Role> {
  await ensureAdminExists(db, bootstrapEmail);
  const res = await db.query("SELECT role FROM collaboration.user_roles WHERE user_id = $1", [userId]);
  return isRole(res.rows[0]?.role) ? res.rows[0].role : "member";
}

export async function requireAdmin(db: Db, bootstrapEmail: string | null, userId: string): Promise<void> {
  if ((await getRole(db, bootstrapEmail, userId)) !== "admin") throw forbidden("Administrator access required");
}

export async function listUsers(db: Db): Promise<AdminUser[]> {
  const res = await db.query(
    `SELECT u.id, u.name, u.email, u."createdAt" AS created_at, COALESCE(r.role, 'member') AS role,
            (SELECT max(s."updatedAt") FROM public.session s WHERE s."userId" = u.id) AS last_active_at
       FROM public."user" u LEFT JOIN collaboration.user_roles r ON r.user_id = u.id
      ORDER BY u."createdAt" ASC`,
  );
  return res.rows.map((row) => ({
    id: row.id, name: row.name, email: row.email, role: isRole(row.role) ? row.role : "member",
    createdAt: new Date(row.created_at).toISOString(),
    lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
  }));
}

/** Change a user's role atomically; the advisory lock serialises concurrent changes so the last-admin check holds. */
export async function setUserRole(pool: Pick<pg.Pool, "connect">, actorId: string, targetId: string, role: Role): Promise<{ id: string; role: Role }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('floq.user_roles'))");
    const user = await client.query('SELECT 1 FROM public."user" WHERE id = $1', [targetId]);
    if (!user.rowCount) throw notFound("User not found");
    const cur = await client.query("SELECT role FROM collaboration.user_roles WHERE user_id = $1", [targetId]);
    const currentRole: Role = isRole(cur.rows[0]?.role) ? cur.rows[0].role : "member";
    const count = await client.query("SELECT count(*)::int AS n FROM collaboration.user_roles WHERE role = 'admin'");
    assertRoleChangeAllowed(currentRole, role, count.rows[0].n as number);
    await client.query(
      `INSERT INTO collaboration.user_roles (user_id, role, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [targetId, role, actorId],
    );
    await client.query("COMMIT");
    log.info("admin.role_changed", { actorId, targetId, from: currentRole, to: role });
    return { id: targetId, role };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
