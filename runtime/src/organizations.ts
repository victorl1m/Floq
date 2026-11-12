import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { QueryResultRow } from "pg";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./errors.js";
import { log } from "./logger.js";
import { moveProjectsInFolders } from "./projectFolders.js";

/**
 * User-wide organizations. Everything lives in the server database (collaboration.*), keyed by the
 * better-auth user id, so an organization follows the account to every device. The client only caches
 * which organization is active. Authorization is decided here from the stored membership, never from
 * anything the client sends.
 *
 * An organization is a partition of each user's OWN projects (floq_projects.organization_id); members do not
 * see each other's projects yet because sandboxes and files are per user. Every user also has one personal
 * organization (created lazily by ensurePersonal) that cannot be deleted, left, renamed or invited to.
 *
 * Invitation delivery: the runtime has no email transport. Invitations are delivered in-app (the invited
 * address sees them in its account menu after signing in) and the inviter also gets a single-use code
 * (returned once, stored only as a SHA-256 hash). The API reports `delivery: "manual"` and never claims an email was sent.
 */

export type OrganizationRole = "owner" | "admin" | "member";
export const INVITABLE_ROLES = ["admin", "member"] as const;

export interface OrganizationLimits {
  maxOrganizationsPerUser: number;
  maxMembersPerOrganization: number;
  maxInvitationsPerDay: number;
  invitationTtlMs: number;
}

export const DEFAULT_ORGANIZATION_LIMITS: OrganizationLimits = {
  maxOrganizationsPerUser: 10,
  maxMembersPerOrganization: 100,
  maxInvitationsPerDay: 20,
  invitationTtlMs: 7 * 24 * 60 * 60 * 1000,
};

export function organizationLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): OrganizationLimits {
  const read = (raw: string | undefined, fallback: number) => {
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxOrganizationsPerUser: read(env.FLOQ_ORG_MAX_PER_USER, DEFAULT_ORGANIZATION_LIMITS.maxOrganizationsPerUser),
    maxMembersPerOrganization: read(env.FLOQ_ORG_MAX_MEMBERS, DEFAULT_ORGANIZATION_LIMITS.maxMembersPerOrganization),
    maxInvitationsPerDay: read(env.FLOQ_ORG_INVITES_PER_DAY, DEFAULT_ORGANIZATION_LIMITS.maxInvitationsPerDay),
    invitationTtlMs: DEFAULT_ORGANIZATION_LIMITS.invitationTtlMs,
  };
}

export interface OrganizationMemberView { id: string; name: string; email: string; role: OrganizationRole }
export interface OrganizationView {
  id: string;
  name: string;
  /** Empty for personal organizations. */
  slug: string;
  role: OrganizationRole;
  personal: boolean;
  createdAt: string;
  members: OrganizationMemberView[];
}
export interface OrganizationInvitationView {
  id: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "expired";
}
export interface IssuedInvitation extends OrganizationInvitationView {
  /** Single-use code. Only returned when the invitation is created or resent. */
  token: string;
  delivery: "manual";
}
export interface IncomingInvitation {
  id: string;
  organization: { id: string; name: string; slug: string };
  role: "admin" | "member";
  invitedBy: string;
  expiresAt: string;
}

type Queryable = Pick<pg.Pool, "query">;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** Personal organizations have no slug (NULL): nothing to squat or collide with. The prefix stays reserved for old rows. */
const RESERVED_SLUG_PREFIX = "personal-";
const PERSONAL_NAME = "Personal";

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const safe = base.length >= 3 ? base : `${base || "org"}-org`.slice(0, 40);
  return safe.startsWith(RESERVED_SLUG_PREFIX) ? `team-${safe}`.slice(0, 40).replace(/-+$/g, "") : safe;
}

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("Email must be text");
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest("Enter a valid email address", "invalid_email");
  return email;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") throw badRequest("Organization name must be text");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw badRequest("Organization name is required");
  if (name.length > 80) throw badRequest("Organization name must be 80 characters or fewer");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw badRequest("Organization name cannot contain control characters");
  return name;
}

function cleanSlug(value: unknown): string {
  if (typeof value !== "string") throw badRequest("Slug must be text", "invalid_slug");
  const slug = value.trim().toLowerCase();
  if (!SLUG_RE.test(slug) || slug.includes("--")) {
    throw badRequest("Use 3-48 lowercase letters, numbers or single hyphens (not at the ends)", "invalid_slug");
  }
  if (slug.startsWith(RESERVED_SLUG_PREFIX)) throw badRequest("The \"personal-\" prefix is reserved", "invalid_slug");
  return slug;
}

function isUniqueViolation(error: unknown, constraintPart?: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "23505") return false;
  if (!constraintPart) return true;
  const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : "";
  const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
  return constraint.includes(constraintPart) || detail.includes(constraintPart);
}

interface MemberRow extends QueryResultRow { organization_id: string; id: string; name: string; email: string; role: OrganizationRole }
interface InviteRow extends QueryResultRow {
  id: string; organization_id: string; email: string; role: "admin" | "member"; invited_by: string;
  invited_by_name: string | null; created_at: Date; expires_at: Date; expired: boolean;
}

function toInvite(row: InviteRow): OrganizationInvitationView {
  return {
    id: row.id, email: row.email, role: row.role, invitedBy: row.invited_by_name || "A teammate",
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    status: row.expired ? "expired" : "pending",
  };
}

export interface OrganizationsOptions {
  limits?: Partial<OrganizationLimits>;
  /**
   * When open sign-up is on, anyone can register an address they do not own, so the in-app inbox and
   * accept-by-id then require a verified email. With sign-up closed (the default) the inviter vouches for the address.
   */
  inboxRequiresVerifiedEmail?: boolean;
}

export class OrganizationsService {
  private readonly limits: OrganizationLimits;
  private readonly inboxRequiresVerifiedEmail: boolean;

  constructor(private readonly pool: pg.Pool, options: OrganizationsOptions = {}) {
    this.limits = { ...DEFAULT_ORGANIZATION_LIMITS, ...options.limits };
    this.inboxRequiresVerifiedEmail = options.inboxRequiresVerifiedEmail ?? false;
  }

  // --- reads ---

  async list(userId: string): Promise<OrganizationView[]> {
    await this.ensurePersonal(userId);
    const orgs = await this.pool.query<{ id: string; name: string; slug: string; role: OrganizationRole; created_at: Date; personal: boolean }>(
      `SELECT o.id, o.name, o.slug, m.role, o.created_at, (o.personal_owner_id IS NOT NULL) AS personal FROM collaboration.organization_members m
       JOIN collaboration.organizations o ON o.id = m.organization_id WHERE m.user_id = $1
       ORDER BY (o.personal_owner_id IS NULL), m.created_at, o.id`,
      [userId],
    );
    if (!orgs.rows.length) return [];
    const members = await this.pool.query<MemberRow>(
      `SELECT m.organization_id, u.id, u.name, u.email, m.role FROM collaboration.organization_members m
       JOIN public."user" u ON u.id = m.user_id WHERE m.organization_id = ANY($1::uuid[]) ORDER BY m.created_at, u.id`,
      [orgs.rows.map((row) => row.id)],
    );
    return orgs.rows.map((row) => ({
      id: row.id, name: row.name, slug: row.slug ?? "", role: row.role, personal: row.personal, createdAt: new Date(row.created_at).toISOString(),
      members: members.rows.filter((member) => member.organization_id === row.id).map(({ id, name, email, role }) => ({ id, name, email, role })),
    }));
  }

  /** Idempotent: returns the id of the user's personal organization, creating it (and the owner membership) when missing. */
  async ensurePersonal(userId: string, db: Queryable = this.pool): Promise<string> {
    await db.query(
      `INSERT INTO collaboration.organizations (id, name, slug, created_by, personal_owner_id)
       VALUES ($1::uuid, $2, NULL, $3, $3) ON CONFLICT (personal_owner_id) DO NOTHING`,
      [randomUUID(), PERSONAL_NAME, userId],
    );
    const found = await db.query<{ id: string }>("SELECT id FROM collaboration.organizations WHERE personal_owner_id = $1", [userId]);
    const id = found.rows[0]?.id;
    if (!id) throw new HttpError(500, "personal_org_missing", "Could not create the personal organization");
    await db.query(
      "INSERT INTO collaboration.organization_members (organization_id, user_id, role) VALUES ($1::uuid, $2, 'owner') ON CONFLICT DO NOTHING",
      [id, userId],
    );
    return id;
  }

  /**
   * Resolves the organization a request acts in. A header value must name an organization the user belongs to
   * (404 organization_not_found otherwise); no header means the personal organization.
   */
  async resolveActive(userId: string, headerValue: string | null | undefined): Promise<string> {
    const value = typeof headerValue === "string" ? headerValue.trim() : "";
    if (!value) return this.ensurePersonal(userId);
    try {
      await this.requireMember(this.pool, userId, value);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw new HttpError(404, "organization_not_found", "Organization not found");
      throw error;
    }
    return value.toLowerCase();
  }

  async members(userId: string, organizationId: string): Promise<OrganizationMemberView[]> {
    await this.requireMember(this.pool, userId, organizationId);
    const result = await this.pool.query<MemberRow>(
      `SELECT m.organization_id, u.id, u.name, u.email, m.role FROM collaboration.organization_members m
       JOIN public."user" u ON u.id = m.user_id WHERE m.organization_id = $1::uuid ORDER BY m.created_at, u.id`,
      [organizationId],
    );
    return result.rows.map(({ id, name, email, role }) => ({ id, name, email, role }));
  }

  async slugAvailable(slug: unknown): Promise<{ slug: string; available: boolean }> {
    const clean = cleanSlug(slug);
    const taken = await this.pool.query("SELECT 1 FROM collaboration.organizations WHERE slug = $1", [clean]);
    return { slug: clean, available: !taken.rowCount };
  }

  // --- organization lifecycle ---

  async create(userId: string, body: Record<string, unknown>): Promise<OrganizationView> {
    const name = cleanName(body.name);
    const explicitSlug = body.slug === undefined || body.slug === null || body.slug === "" ? undefined : cleanSlug(body.slug);
    const organizationId = randomUUID();
    let slug = explicitSlug ?? slugify(name);
    await this.tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`floq.org.user.${userId}`]);
      const count = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM collaboration.organization_members m JOIN collaboration.organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1 AND o.personal_owner_id IS NULL`, [userId]);
      if (Number(count.rows[0]?.n ?? 0) >= this.limits.maxOrganizationsPerUser) {
        throw conflict(`You can belong to at most ${this.limits.maxOrganizationsPerUser} organizations`, "organization_limit");
      }
      if (!explicitSlug) {
        // A derived slug quietly gets a suffix when taken; an explicit one is the user's choice and must be free.
        const taken = await db.query("SELECT 1 FROM collaboration.organizations WHERE slug = $1", [slug]);
        if (taken.rowCount) slug = `${slug.slice(0, 41)}-${randomBytes(3).toString("hex")}`;
      }
      try {
        await db.query("INSERT INTO collaboration.organizations (id, name, slug, created_by) VALUES ($1::uuid, $2, $3, $4)", [organizationId, name, slug, userId]);
      } catch (error) {
        if (isUniqueViolation(error, "slug")) throw conflict("That URL name is already taken", "slug_taken");
        throw error;
      }
      await db.query("INSERT INTO collaboration.organization_members (organization_id, user_id, role) VALUES ($1::uuid, $2, 'owner')", [organizationId, userId]);
      await this.audit(db, organizationId, userId, "org.created", organizationId, { slug });
    });
    return (await this.list(userId)).find((org) => org.id === organizationId)!;
  }

  async rename(userId: string, organizationId: string, rawName: unknown): Promise<void> {
    const name = cleanName(rawName);
    const role = await this.requireMember(this.pool, userId, organizationId);
    if (role !== "owner") throw forbidden("Only the owner can rename the organization");
    await this.assertNotPersonal(this.pool, organizationId);
    await this.pool.query("UPDATE collaboration.organizations SET name = $2 WHERE id = $1::uuid", [organizationId, name]);
  }

  async remove(userId: string, organizationId: string, confirm: unknown): Promise<void> {
    await this.tx(async (db) => {
      const role = await this.lockedRole(db, userId, organizationId);
      if (role !== "owner") throw forbidden("Only the owner can delete the organization");
      await this.assertNotPersonal(db, organizationId);
      const org = await db.query<{ name: string; slug: string }>("SELECT name, slug FROM collaboration.organizations WHERE id = $1::uuid", [organizationId]);
      const row = org.rows[0];
      if (!row) throw notFound();
      if (typeof confirm !== "string" || confirm.trim() !== row.name) throw badRequest("Type the organization name to confirm deletion", "confirmation_mismatch");
      await this.audit(db, organizationId, userId, "org.deleted", organizationId, { name: row.name, slug: row.slug });
      // Every member's projects in this organization return to their own personal organization (no files or agents are touched).
      const returned = await this.reassignProjects(db, organizationId);
      await db.query("DELETE FROM collaboration.organizations WHERE id = $1::uuid", [organizationId]);
      if (returned) log.info("org.projects_returned", { organizationId, projects: returned });
    });
  }

  async leave(userId: string, organizationId: string): Promise<void> {
    await this.tx(async (db) => {
      const role = await this.lockedRole(db, userId, organizationId);
      await this.assertNotPersonal(db, organizationId);
      if (role === "owner") throw conflict("Transfer ownership to another member (or delete the organization) before leaving", "owner_must_transfer");
      await this.reassignProjects(db, organizationId, userId);
      await db.query("DELETE FROM collaboration.organization_members WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, userId]);
      await this.audit(db, organizationId, userId, "org.left", userId);
    });
  }

  // --- members ---

  async setMemberRole(actorId: string, organizationId: string, targetId: string, rawRole: unknown): Promise<void> {
    if (rawRole !== "admin" && rawRole !== "member") throw badRequest("Role must be admin or member", "invalid_role");
    await this.tx(async (db) => {
      const actor = await this.lockedRole(db, actorId, organizationId);
      if (actor !== "owner") throw forbidden("Only the owner can change roles");
      await this.assertNotPersonal(db, organizationId);
      if (targetId === actorId) throw badRequest("Transfer ownership instead of changing your own role", "invalid_role");
      const target = await this.targetRole(db, organizationId, targetId);
      if (target === "owner") throw forbidden("The owner's role can only change by transferring ownership");
      await db.query("UPDATE collaboration.organization_members SET role = $3 WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, targetId, rawRole]);
      await this.audit(db, organizationId, actorId, "org.role_changed", targetId, { from: target, to: rawRole });
    });
  }

  async removeMember(actorId: string, organizationId: string, targetId: string): Promise<void> {
    await this.tx(async (db) => {
      const actor = await this.lockedRole(db, actorId, organizationId);
      if (actor === "member") throw forbidden("Only owners and admins can remove members");
      await this.assertNotPersonal(db, organizationId);
      if (targetId === actorId) throw badRequest("Use Leave organization to remove yourself", "use_leave");
      const target = await this.targetRole(db, organizationId, targetId);
      if (target === "owner") throw forbidden("The owner cannot be removed");
      if (actor === "admin" && target !== "member") throw forbidden("Admins can only remove members");
      await this.reassignProjects(db, organizationId, targetId);
      await db.query("DELETE FROM collaboration.organization_members WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, targetId]);
      await this.audit(db, organizationId, actorId, "org.removed", targetId, { role: target });
    });
  }

  async transferOwnership(actorId: string, organizationId: string, targetId: unknown): Promise<void> {
    if (typeof targetId !== "string" || !targetId) throw badRequest("Choose a member to transfer ownership to");
    await this.tx(async (db) => {
      const actor = await this.lockedRole(db, actorId, organizationId);
      if (actor !== "owner") throw forbidden("Only the owner can transfer ownership");
      await this.assertNotPersonal(db, organizationId);
      if (targetId === actorId) throw badRequest("You already own this organization");
      await this.targetRole(db, organizationId, targetId);
      await db.query("UPDATE collaboration.organization_members SET role = 'owner' WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, targetId]);
      await db.query("UPDATE collaboration.organization_members SET role = 'admin' WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, actorId]);
      await this.audit(db, organizationId, actorId, "org.transferred", targetId);
    });
  }

  // --- invitations (managed by owners and admins) ---

  async listInvitations(userId: string, organizationId: string): Promise<OrganizationInvitationView[]> {
    const role = await this.requireMember(this.pool, userId, organizationId);
    if (role === "member") throw forbidden("Only owners and admins can see invitations");
    const result = await this.pool.query<InviteRow>(
      `SELECT i.id, i.organization_id, i.email, i.role, i.invited_by, u.name AS invited_by_name, i.created_at, i.expires_at, (i.expires_at <= now()) AS expired
       FROM collaboration.organization_invitations i LEFT JOIN public."user" u ON u.id = i.invited_by
       WHERE i.organization_id = $1::uuid ORDER BY i.created_at DESC`,
      [organizationId],
    );
    return result.rows.map(toInvite);
  }

  async invite(actorId: string, organizationId: string, body: Record<string, unknown>): Promise<IssuedInvitation> {
    const email = normalizeEmail(body.email);
    const role = body.role === undefined ? "member" : body.role;
    if (role !== "admin" && role !== "member") throw badRequest("Role must be admin or member", "invalid_role");
    return this.tx(async (db) => {
      const actor = await this.lockedRole(db, actorId, organizationId);
      if (actor === "member") throw forbidden("Only owners and admins can invite people");
      await this.assertNotPersonal(db, organizationId);
      if (actor === "admin" && role !== "member") throw forbidden("Only the owner can invite admins");
      await this.assertInviteQuota(db, organizationId);
      await this.assertRoom(db, organizationId, 1);
      const existingMember = await db.query(
        `SELECT 1 FROM collaboration.organization_members m JOIN public."user" u ON u.id = m.user_id
         WHERE m.organization_id = $1::uuid AND lower(u.email) = $2`,
        [organizationId, email],
      );
      if (existingMember.rowCount) throw conflict("This person is already in the organization", "already_member");
      // Expired rows are dead weight (and would trip the unique key); a live one blocks a duplicate.
      await db.query("DELETE FROM collaboration.organization_invitations WHERE organization_id = $1::uuid AND lower(email) = $2 AND expires_at <= now()", [organizationId, email]);
      const pending = await db.query("SELECT 1 FROM collaboration.organization_invitations WHERE organization_id = $1::uuid AND lower(email) = $2", [organizationId, email]);
      if (pending.rowCount) throw conflict("This email already has a pending invitation. Resend it instead.", "already_invited");
      const token = randomBytes(24).toString("base64url");
      const id = randomUUID();
      const inserted = await db.query<InviteRow>(
        `INSERT INTO collaboration.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, now() + ($7 || ' milliseconds')::interval)
         RETURNING id, organization_id, email, role, invited_by, created_at, expires_at, false AS expired`,
        [id, organizationId, email, role, hashToken(token), actorId, String(this.limits.invitationTtlMs)],
      );
      await this.audit(db, organizationId, actorId, "org.invited", email, { role, invitationId: id });
      const me = await db.query<{ name: string }>('SELECT name FROM public."user" WHERE id = $1', [actorId]);
      return { ...toInvite({ ...inserted.rows[0], invited_by_name: me.rows[0]?.name ?? null }), token, delivery: "manual" as const };
    });
  }

  async resendInvitation(actorId: string, organizationId: string, invitationId: string): Promise<IssuedInvitation> {
    return this.tx(async (db) => {
      const invite = await this.lockedInvitation(db, actorId, organizationId, invitationId);
      await this.assertInviteQuota(db, organizationId);
      const token = randomBytes(24).toString("base64url");
      const updated = await db.query<InviteRow>(
        `UPDATE collaboration.organization_invitations SET token_hash = $2, created_at = now(), invited_by = $3, expires_at = now() + ($4 || ' milliseconds')::interval
         WHERE id = $1::uuid RETURNING id, organization_id, email, role, invited_by, created_at, expires_at, false AS expired`,
        [invite.id, hashToken(token), actorId, String(this.limits.invitationTtlMs)],
      );
      await this.audit(db, organizationId, actorId, "org.invited", invite.email, { role: invite.role, invitationId: invite.id, resend: true });
      const me = await db.query<{ name: string }>('SELECT name FROM public."user" WHERE id = $1', [actorId]);
      return { ...toInvite({ ...updated.rows[0], invited_by_name: me.rows[0]?.name ?? null }), token, delivery: "manual" as const };
    });
  }

  async cancelInvitation(actorId: string, organizationId: string, invitationId: string): Promise<void> {
    await this.tx(async (db) => {
      const invite = await this.lockedInvitation(db, actorId, organizationId, invitationId);
      await db.query("DELETE FROM collaboration.organization_invitations WHERE id = $1::uuid", [invite.id]);
      await this.audit(db, organizationId, actorId, "org.invite_cancelled", invite.email, { invitationId: invite.id });
    });
  }

  // --- invitee side ---

  async incomingInvitations(userId: string): Promise<IncomingInvitation[]> {
    const email = await this.inviteeEmail(this.pool, userId, false);
    if (!email) return [];
    const result = await this.pool.query<{ id: string; organization_id: string; name: string; slug: string; role: "admin" | "member"; inviter: string | null; expires_at: Date }>(
      `SELECT i.id, i.organization_id, o.name, o.slug, i.role, u.name AS inviter, i.expires_at
       FROM collaboration.organization_invitations i JOIN collaboration.organizations o ON o.id = i.organization_id
       LEFT JOIN public."user" u ON u.id = i.invited_by
       WHERE lower(i.email) = $1 AND i.expires_at > now() ORDER BY i.created_at DESC`,
      [email],
    );
    return result.rows.map((row) => ({
      id: row.id, organization: { id: row.organization_id, name: row.name, slug: row.slug }, role: row.role,
      invitedBy: row.inviter || "A teammate", expiresAt: new Date(row.expires_at).toISOString(),
    }));
  }

  /** Accept from the in-app inbox (by invitation id). A non-matching or missing invitation is reported as not found. */
  async acceptById(userId: string, invitationId: string): Promise<{ organizationId: string }> {
    return this.consume(userId, { id: invitationId }, true);
  }

  /** Accept with the single-use code the inviter shared. */
  async acceptByToken(userId: string, rawToken: unknown): Promise<{ organizationId: string }> {
    if (typeof rawToken !== "string" || !rawToken.trim() || rawToken.length > 128) throw badRequest("Invitation code is required");
    return this.consume(userId, { tokenHash: hashToken(rawToken.trim()) }, false);
  }

  async decline(userId: string, invitationId: string): Promise<void> {
    await this.tx(async (db) => {
      const email = await this.inviteeEmail(db, userId, true);
      const result = await db.query<{ id: string; organization_id: string; email: string }>(
        "SELECT id, organization_id, email FROM collaboration.organization_invitations WHERE id = $1::uuid FOR UPDATE",
        [invitationId],
      ).catch(() => ({ rows: [] as { id: string; organization_id: string; email: string }[] }));
      const invite = result.rows[0];
      if (!invite || invite.email.toLowerCase() !== email) throw notFound("Invitation not found");
      await db.query("DELETE FROM collaboration.organization_invitations WHERE id = $1::uuid", [invite.id]);
      await this.audit(db, invite.organization_id, userId, "org.declined", invite.email, { invitationId: invite.id });
    });
  }

  // --- internals ---

  private async consume(userId: string, key: { id: string } | { tokenHash: string }, byId: boolean): Promise<{ organizationId: string }> {
    return this.tx(async (db) => {
      const email = await this.inviteeEmail(db, userId, byId);
      const lookup = "id" in key
        ? await db.query<{ id: string; organization_id: string; email: string; role: "admin" | "member"; expired: boolean }>(
            "SELECT id, organization_id, email, role, (expires_at <= now()) AS expired FROM collaboration.organization_invitations WHERE id = $1::uuid FOR UPDATE", [key.id])
            .catch(() => ({ rows: [] as never[] }))
        : await db.query<{ id: string; organization_id: string; email: string; role: "admin" | "member"; expired: boolean }>(
            "SELECT id, organization_id, email, role, (expires_at <= now()) AS expired FROM collaboration.organization_invitations WHERE token_hash = $1 FOR UPDATE", [key.tokenHash]);
      const invite = lookup.rows[0];
      if (!invite || invite.expired) throw notFound("Invitation is invalid or has expired");
      if (!email || invite.email.toLowerCase() !== email) {
        throw byId ? notFound("Invitation is invalid or has expired") : forbidden("Sign in with the email address this invitation was sent to");
      }
      // Serialise with member-changing operations on the same organization and with this user's other joins.
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`floq.org.user.${userId}`]);
      const org = await db.query("SELECT 1 FROM collaboration.organizations WHERE id = $1::uuid FOR UPDATE", [invite.organization_id]);
      if (!org.rowCount) throw notFound("Invitation is invalid or has expired");
      const already = await db.query("SELECT 1 FROM collaboration.organization_members WHERE organization_id = $1::uuid AND user_id = $2", [invite.organization_id, userId]);
      if (!already.rowCount) {
        const joined = await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM collaboration.organization_members m JOIN collaboration.organizations o ON o.id = m.organization_id
           WHERE m.user_id = $1 AND o.personal_owner_id IS NULL`, [userId]);
        if (Number(joined.rows[0]?.n ?? 0) >= this.limits.maxOrganizationsPerUser) {
          throw conflict(`You can belong to at most ${this.limits.maxOrganizationsPerUser} organizations`, "organization_limit");
        }
        await this.assertRoom(db, invite.organization_id, 0);
        await db.query("INSERT INTO collaboration.organization_members (organization_id, user_id, role) VALUES ($1::uuid, $2, $3)", [invite.organization_id, userId, invite.role]);
      }
      await db.query("DELETE FROM collaboration.organization_invitations WHERE id = $1::uuid", [invite.id]);
      await this.audit(db, invite.organization_id, userId, "org.accepted", invite.email, { role: invite.role, invitationId: invite.id });
      return { organizationId: invite.organization_id };
    });
  }

  /** The signed-in user's normalized email, or null when it cannot be trusted to receive invitations by id. */
  private async inviteeEmail(db: Queryable, userId: string, strict: boolean): Promise<string | null> {
    const result = await db.query<{ email: string; verified: boolean }>('SELECT email, coalesce("emailVerified", false) AS verified FROM public."user" WHERE id = $1', [userId]);
    const row = result.rows[0];
    if (!row) return null;
    if (this.inboxRequiresVerifiedEmail && !row.verified && strict) throw forbidden("Verify your email address before accepting invitations");
    if (this.inboxRequiresVerifiedEmail && !row.verified) return null;
    return row.email.trim().toLowerCase();
  }

  private async assertInviteQuota(db: Queryable, organizationId: string): Promise<void> {
    const sent = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM collaboration.organization_audit_events WHERE organization_id = $1::uuid AND event = 'org.invited' AND created_at > now() - interval '24 hours'",
      [organizationId],
    );
    if (Number(sent.rows[0]?.n ?? 0) >= this.limits.maxInvitationsPerDay) {
      throw new HttpError(429, "invitation_rate_limit", `This organization can send at most ${this.limits.maxInvitationsPerDay} invitations per day`);
    }
  }

  /** Members plus live invitations (each will become a member) must stay within the cap. */
  private async assertRoom(db: Queryable, organizationId: string, extra: number): Promise<void> {
    const counts = await db.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM collaboration.organization_members WHERE organization_id = $1::uuid)
            + (SELECT count(*) FROM collaboration.organization_invitations WHERE organization_id = $1::uuid AND expires_at > now()) AS n`,
      [organizationId],
    );
    if (Number(counts.rows[0]?.n ?? 0) + extra > this.limits.maxMembersPerOrganization) {
      throw conflict(`An organization can have at most ${this.limits.maxMembersPerOrganization} members`, "organization_full");
    }
  }

  private async lockedInvitation(db: Queryable, actorId: string, organizationId: string, invitationId: string): Promise<{ id: string; email: string; role: "admin" | "member" }> {
    const actor = await this.lockedRole(db, actorId, organizationId);
    if (actor === "member") throw forbidden("Only owners and admins can manage invitations");
    const result = await db.query<{ id: string; email: string; role: "admin" | "member" }>(
      "SELECT id, email, role FROM collaboration.organization_invitations WHERE id = $1::uuid AND organization_id = $2::uuid FOR UPDATE",
      [invitationId, organizationId],
    ).catch(() => ({ rows: [] as { id: string; email: string; role: "admin" | "member" }[] }));
    const invite = result.rows[0];
    if (!invite) throw notFound("Invitation not found");
    if (actor === "admin" && invite.role !== "member") throw forbidden("Only the owner can manage admin invitations");
    return invite;
  }

  /**
   * Moves the projects (of `onlyUserId`, or of every member) that live in `organizationId` to their owner's personal
   * organization, and their folder-layout entries with them. Runs inside the caller's transaction, before the membership
   * or organization row is removed. Returns the number of projects moved. Skipped when the app tables do not exist.
   */
  private async reassignProjects(db: Queryable, organizationId: string, onlyUserId?: string): Promise<number> {
    const present = await db.query("SELECT to_regclass('public.floq_projects') IS NOT NULL AS ok");
    if (!present.rows[0]?.ok) return 0;
    const owners = await db.query<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM floq_projects WHERE organization_id = $1::uuid" + (onlyUserId ? " AND user_id = $2" : ""),
      onlyUserId ? [organizationId, onlyUserId] : [organizationId],
    );
    let moved = 0;
    for (const { user_id: owner } of owners.rows) {
      const personal = await this.ensurePersonal(owner, db);
      const rows = await db.query<{ id: string }>(
        "UPDATE floq_projects SET organization_id = $3::uuid WHERE organization_id = $1::uuid AND user_id = $2 RETURNING id",
        [organizationId, owner, personal],
      );
      moved += rows.rows.length;
      await moveProjectsInFolders(db, owner, rows.rows.map((r) => r.id), organizationId, personal);
    }
    return moved;
  }

  private async assertNotPersonal(db: Queryable, organizationId: string): Promise<void> {
    const result = await db.query("SELECT 1 FROM collaboration.organizations WHERE id = $1::uuid AND personal_owner_id IS NOT NULL", [organizationId]);
    if (result.rowCount) throw conflict("Your personal organization cannot be changed this way", "personal_org");
  }

  async requireMember(db: Queryable, userId: string, organizationId: string): Promise<OrganizationRole> {
    const result = await db.query<{ role: OrganizationRole }>(
      "SELECT role FROM collaboration.organization_members WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, userId],
    ).catch(() => ({ rows: [] as { role: OrganizationRole }[] }));
    if (!result.rows[0]) throw notFound();
    return result.rows[0].role;
  }

  /** Locks the organization row (serialising owner/admin changes), then returns the actor's role. Non-members get 404. */
  private async lockedRole(db: Queryable, userId: string, organizationId: string): Promise<OrganizationRole> {
    const locked = await db.query("SELECT 1 FROM collaboration.organizations WHERE id = $1::uuid FOR UPDATE", [organizationId]).catch(() => ({ rowCount: 0 }));
    if (!locked.rowCount) throw notFound();
    return this.requireMember(db, userId, organizationId);
  }

  private async targetRole(db: Queryable, organizationId: string, targetId: string): Promise<OrganizationRole> {
    const result = await db.query<{ role: OrganizationRole }>(
      "SELECT role FROM collaboration.organization_members WHERE organization_id = $1::uuid AND user_id = $2", [organizationId, targetId],
    );
    if (!result.rows[0]) throw notFound("That person is not in this organization");
    return result.rows[0].role;
  }

  private async audit(db: Queryable, organizationId: string, actorId: string, event: string, target: string | null, meta: Record<string, unknown> = {}): Promise<void> {
    await db.query(
      "INSERT INTO collaboration.organization_audit_events (id, organization_id, actor_id, event, target, meta) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)",
      [randomUUID(), organizationId, actorId, event, target, JSON.stringify(meta)],
    );
    log.info(event, { organizationId, actorId, target });
  }

  private async tx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface OrganizationRouteContext {
  service: OrganizationsService;
  userId: string;
  method: string;
  pathname: string;
  readJson: <T>() => Promise<T>;
}

/**
 * HTTP surface for organizations. Returns undefined when the path is not an organization-management route
 * (task boards under /v1/organizations/:id/boards stay with the tasks router).
 */
export async function routeOrganizations(ctx: OrganizationRouteContext): Promise<{ status: number; body: unknown } | undefined> {
  const { service, userId, method, pathname } = ctx;
  const ok = (body: unknown, status = 200) => ({ status, body });
  const body = () => ctx.readJson<Record<string, unknown>>();

  if (pathname === "/v1/organizations") {
    if (method === "GET") return ok({ organizations: await service.list(userId) });
    if (method === "POST") return ok({ organization: await service.create(userId, await body()) }, 201);
    return undefined;
  }
  const slug = /^\/v1\/organization-slugs\/([^/]+)$/.exec(pathname);
  if (slug && method === "GET") return ok(await service.slugAvailable(decodeURIComponent(slug[1])));
  if (pathname === "/v1/me/organization-invitations" && method === "GET") return ok({ invitations: await service.incomingInvitations(userId) });
  if (pathname === "/v1/organization-invitations/accept" && method === "POST") return ok(await service.acceptByToken(userId, (await body()).token));
  const incoming = /^\/v1\/organization-invitations\/([\w-]+)\/(accept|decline)$/.exec(pathname);
  if (incoming && method === "POST") {
    if (incoming[2] === "accept") return ok(await service.acceptById(userId, incoming[1]));
    await service.decline(userId, incoming[1]);
    return ok({ ok: true });
  }

  const match = /^\/v1\/organizations\/([\w-]+)(?:\/(members|invitations|transfer|leave)(?:\/([\w-]+)(?:\/(resend))?)?)?$/.exec(pathname);
  if (!match) return undefined;
  const [, organizationId, section, childId, childAction] = match;
  if (!section) {
    if (method === "GET") return ok({ members: await service.members(userId, organizationId) });
    if (method === "PATCH") { await service.rename(userId, organizationId, (await body()).name); return ok({ ok: true }); }
    if (method === "DELETE") { await service.remove(userId, organizationId, (await body()).confirm); return ok({ ok: true }); }
    return undefined;
  }
  if (section === "leave" && method === "POST" && !childId) { await service.leave(userId, organizationId); return ok({ ok: true }); }
  if (section === "transfer" && method === "POST" && !childId) { await service.transferOwnership(userId, organizationId, (await body()).userId); return ok({ ok: true }); }
  if (section === "members" && childId && !childAction) {
    if (method === "PATCH") { await service.setMemberRole(userId, organizationId, childId, (await body()).role); return ok({ ok: true }); }
    if (method === "DELETE") { await service.removeMember(userId, organizationId, childId); return ok({ ok: true }); }
  }
  if (section === "invitations") {
    if (!childId && method === "GET") return ok({ invitations: await service.listInvitations(userId, organizationId) });
    if (!childId && method === "POST") return ok({ invitation: await service.invite(userId, organizationId, await body()) }, 201);
    if (childId && childAction === "resend" && method === "POST") return ok({ invitation: await service.resendInvitation(userId, organizationId, childId) });
    if (childId && !childAction && method === "DELETE") { await service.cancelInvitation(userId, organizationId, childId); return ok({ ok: true }); }
  }
  return undefined;
}
