import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";

export interface InvitationRegistration {
  token: string;
  email: string;
  name: string;
  password: string;
}

export interface RegisteredInvitation {
  userId: string;
  organizationId: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

interface InvitationRow extends QueryResultRow {
  id: string;
  organization_id: string;
  email: string;
}

interface UserRow extends QueryResultRow {
  id: string;
}

async function findInvitation(pool: Pool, tokenHash: string): Promise<InvitationRow | undefined> {
  const result = await pool.query<InvitationRow>(
    "SELECT id, organization_id, email FROM collaboration.organization_invitations WHERE token_hash = $1 AND expires_at > now()",
    [tokenHash],
  );
  return result.rows[0];
}

/**
 * Create a credential account and consume its invitation in one PostgreSQL transaction.
 * The small preflight avoids hashing passwords for unknown tokens. Every fact is rechecked
 * under a row lock before writes, so concurrent use of a single invitation has one winner.
 */
export async function registerWithInvitation(
  pool: Pool,
  input: InvitationRegistration,
  hashPassword: (password: string) => Promise<string>,
): Promise<RegisteredInvitation> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const token = input.token.trim();
  if (!token || token.length > 128) throw notFound("Invitation is invalid or has expired");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address");
  if (!name || name.length > 100) throw badRequest("Name must be 1-100 characters");
  if (input.password.length < 12 || input.password.length > 128) throw badRequest("Password must be 12-128 characters", "invalid_password");

  const digest = hashToken(token);
  const initialInvite = await findInvitation(pool, digest);
  if (!initialInvite) throw notFound("Invitation is invalid or has expired");
  if (initialInvite.email.toLowerCase() !== email) throw forbidden("These details do not match the invitation");
  const initialAccount = await pool.query<UserRow>('SELECT id FROM public."user" WHERE lower(email) = $1 LIMIT 1', [email]);
  if (initialAccount.rowCount) throw conflict("This email already has an account. Sign in and accept the invitation.", "invitation_account_exists");

  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const client: PoolClient = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const invitation = await client.query<InvitationRow>(
      "SELECT id, organization_id, email FROM collaboration.organization_invitations WHERE token_hash = $1 AND expires_at > now() FOR UPDATE",
      [digest],
    );
    const row = invitation.rows[0];
    if (!row) throw notFound("Invitation is invalid or has expired");
    if (row.email.toLowerCase() !== email) throw forbidden("These details do not match the invitation");
    const existing = await client.query<UserRow>('SELECT id FROM public."user" WHERE lower(email) = $1 LIMIT 1 FOR UPDATE', [email]);
    if (existing.rowCount) throw conflict("This email already has an account. Sign in and accept the invitation.", "invitation_account_exists");

    await client.query(
      'INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, now(), now())',
      [userId, name, email],
    );
    await client.query(
      'INSERT INTO public.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, \'credential\', $3, $4, now(), now())',
      [accountId, userId, userId, passwordHash],
    );
    await client.query(
      "INSERT INTO collaboration.organization_members (organization_id, user_id, role) VALUES ($1::uuid, $2, 'member')",
      [row.organization_id, userId],
    );
    const consumed = await client.query(
      "DELETE FROM collaboration.organization_invitations WHERE id = $1::uuid AND token_hash = $2 AND expires_at > now() RETURNING id",
      [row.id, digest],
    );
    if (consumed.rowCount !== 1) throw notFound("Invitation is invalid or has expired");
    await client.query("COMMIT");
    transactionStarted = false;
    return { userId, organizationId: row.organization_id };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      throw conflict("This email already has an account. Sign in and accept the invitation.", "invitation_account_exists");
    }
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
