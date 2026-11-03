import { randomUUID } from "node:crypto";
import type pg from "pg";
import { badRequest } from "./errors.js";

export interface BootstrapAdminInput {
  email: string;
  password: string;
  name?: string;
  companyName?: string;
}

export function bootstrapTeamName(name: string | undefined, email: string): string {
  const firstName = name?.trim().split(/\s+/)[0] || email.trim().split("@")[0] || "Admin";
  return `${firstName.slice(0, 72)}'s Team`;
}

/**
 * Create the initial credential account and owned team in one transaction.
 * The caller has already checked that this is the configured bootstrap address.
 */
export async function registerBootstrapAdmin(
  pool: Pick<pg.Pool, "query" | "connect">,
  input: BootstrapAdminInput,
  hashPassword: (password: string) => Promise<string>,
): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || "Admin";
  const companyName = input.companyName?.trim() ?? "";
  if (name.length > 100) throw badRequest("Name must be 100 characters or fewer");
  if (companyName.length > 80) throw badRequest("Company name must be 80 characters or fewer");
  const teamName = companyName || bootstrapTeamName(name, email);

  const existing = await pool.query('SELECT 1 FROM public."user" WHERE lower(email) = $1 LIMIT 1', [email]);
  if (existing.rowCount) return false;

  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const teamId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`floq.bootstrap.${email}`]);
    const raced = await client.query('SELECT 1 FROM public."user" WHERE lower(email) = $1 LIMIT 1 FOR UPDATE', [email]);
    if (raced.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      'INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())',
      [userId, name, email],
    );
    await client.query(
      'INSERT INTO public.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, \'credential\', $3, $4, now(), now())',
      [accountId, userId, userId, passwordHash],
    );
    await client.query(
      "INSERT INTO collaboration.teams (id, name, created_by, created_at) VALUES ($1::uuid, $2, $3, now())",
      [teamId, teamName, userId],
    );
    await client.query(
      "INSERT INTO collaboration.team_members (team_id, user_id, role, created_at) VALUES ($1::uuid, $2, 'owner', now())",
      [teamId, userId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      const raced = await pool.query('SELECT 1 FROM public."user" WHERE lower(email) = $1 LIMIT 1', [email]);
      if (raced.rowCount) return false;
    }
    throw error;
  } finally {
    client.release();
  }
}
