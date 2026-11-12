import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { OrganizationsService, routeOrganizations, slugify, type OrganizationLimits } from "../dist/organizations.js";

const A = "u-owner", B = "u-admin", C = "u-member", D = "u-outsider";
const EMAILS: Record<string, string> = { [A]: "owner@example.com", [B]: "admin@example.com", [C]: "member@example.com", [D]: "out@example.com" };

async function setup(limits: Partial<OrganizationLimits> = {}, options: { verified?: boolean; inboxRequiresVerifiedEmail?: boolean } = {}) {
  const db = new PGlite();
  let tail: Promise<void> = Promise.resolve();
  const run = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  const pool = {
    query: run,
    // PGlite is one connection: serialise whole transactions so concurrent callers cannot interleave BEGIN/COMMIT.
    async connect() {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      return { query: run, release };
    },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" BOOLEAN DEFAULT false)`);
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) {
    await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  }
  for (const [id, email] of Object.entries(EMAILS)) {
    await db.query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)`, [id, id.replace("u-", ""), email, options.verified ?? true]);
  }
  const service = new OrganizationsService(pool as never, { limits, inboxRequiresVerifiedEmail: options.inboxRequiresVerifiedEmail });
  return { db, service, pool };
}

async function fixture(limits?: Partial<OrganizationLimits>) {
  const ctx = await setup(limits);
  const org = await ctx.service.create(A, { name: "Acme Inc" });
  const join = async (userId: string, role: "admin" | "member") => {
    const invite = await ctx.service.invite(A, org.id, { email: EMAILS[userId], role });
    await ctx.service.acceptByToken(userId, invite.token);
  };
  return { ...ctx, org, join };
}

/** Team organizations only: every user also has a personal one (covered by its own tests). */
const teams = async (service: OrganizationsService, userId: string) => (await service.list(userId)).filter((o) => !o.personal);

const rejects = (promise: Promise<unknown>, status: number, code?: string) =>
  assert.rejects(promise, (error: { status?: number; code?: string }) => error.status === status && (!code || error.code === code));

test("create: owner membership, derived slug, uniqueness, validation, user-wide listing", async (t) => {
  const { db, service } = await setup();
  t.after(() => db.close());
  assert.equal(slugify("  Acme -- Inc! "), "acme-inc");
  const org = await service.create(A, { name: "  Acme   Inc " });
  assert.equal(org.name, "Acme Inc");
  assert.equal(org.slug, "acme-inc");
  assert.equal(org.role, "owner");
  assert.deepEqual(org.members.map((m) => [m.id, m.role]), [[A, "owner"]]);

  const second = await service.create(B, { name: "Acme Inc" });
  assert.notEqual(second.slug, "acme-inc", "derived slug gets a suffix when taken");
  await rejects(service.create(B, { name: "Other", slug: "acme-inc" }), 409, "slug_taken");
  await rejects(service.create(B, { name: "Other", slug: "Bad Slug!" }), 400, "invalid_slug");
  await rejects(service.create(B, { name: "x".repeat(81) }), 400);
  await rejects(service.create(B, { name: "   " }), 400);
  assert.deepEqual(await service.slugAvailable("acme-inc"), { slug: "acme-inc", normalized: "acme-inc", available: false, reason: "taken" });
  assert.equal((await service.slugAvailable("fresh-one")).available, true);

  // Server-side and user-wide: the list comes from the database, keyed by account.
  assert.equal((await teams(service, A)).length, 1);
  assert.equal((await teams(service, D)).length, 0);
  const audit = await db.query<{ event: string }>("SELECT event FROM collaboration.organization_audit_events");
  assert.deepEqual(audit.rows.map((r) => r.event), ["org.created", "org.created"]);
});

test("role permission matrix", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await join(B, "admin");
  await join(C, "member");

  await service.update(B, org.id, { name: "Admin Edit" });
  await rejects(service.update(C, org.id, { name: "Nope" }), 403);
  await service.update(A, org.id, { name: "Acme Corp" });
  await rejects(service.setMemberRole(B, org.id, C, "admin"), 403);
  await rejects(service.transferOwnership(B, org.id, C), 403);
  await rejects(service.remove(B, org.id, "Acme Corp"), 403);
  await rejects(service.remove(C, org.id, "Acme Corp"), 403);

  await rejects(service.invite(C, org.id, { email: "x@example.com" }), 403);
  await rejects(service.invite(B, org.id, { email: "x@example.com", role: "admin" }), 403);
  const memberInvite = await service.invite(B, org.id, { email: "x@example.com" });
  assert.equal(memberInvite.role, "member");
  const adminInvite = await service.invite(A, org.id, { email: "y@example.com", role: "admin" });
  await rejects(service.cancelInvitation(B, org.id, adminInvite.id), 403);
  await rejects(service.resendInvitation(B, org.id, adminInvite.id), 403);
  await rejects(service.listInvitations(C, org.id), 403);
  assert.equal((await service.listInvitations(B, org.id)).length, 2);
  await service.cancelInvitation(B, org.id, memberInvite.id);

  await rejects(service.removeMember(C, org.id, B), 403);
  await rejects(service.removeMember(B, org.id, A), 403);
  await rejects(service.removeMember(B, org.id, B), 400, "use_leave");
  await service.setMemberRole(A, org.id, C, "admin");
  await rejects(service.removeMember(B, org.id, C), 403);
  await service.setMemberRole(A, org.id, C, "member");
  await service.removeMember(B, org.id, C);
  assert.deepEqual((await service.members(A, org.id)).map((m) => m.id), [A, B]);
  await rejects(service.setMemberRole(A, org.id, A, "member"), 400);
  await rejects(service.setMemberRole(A, org.id, B, "owner" as never), 400, "invalid_role");
});

test("non-members cannot read or act on an organization (404, no existence leak)", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await join(C, "member");
  const invite = await service.invite(A, org.id, { email: "later@example.com" });
  await rejects(service.members(D, org.id), 404);
  await rejects(service.listInvitations(D, org.id), 404);
  await rejects(service.invite(D, org.id, { email: "z@example.com" }), 404);
  await rejects(service.update(D, org.id, { name: "Mine" }), 404);
  await rejects(service.remove(D, org.id, "Acme Inc"), 404);
  await rejects(service.leave(D, org.id), 404);
  await rejects(service.removeMember(D, org.id, C), 404);
  await rejects(service.cancelInvitation(D, org.id, invite.id), 404);
  await rejects(service.members(D, "not-a-uuid"), 404);
  assert.deepEqual(await teams(service, D), []);
});

test("invite then accept by id; the inbox is bound to the signed-in email", async (t) => {
  const { db, service, org } = await fixture();
  t.after(() => db.close());
  const invite = await service.invite(A, org.id, { email: "  MEMBER@Example.com ", role: "admin" });
  assert.equal(invite.email, "member@example.com");
  assert.equal(invite.delivery, "manual");
  assert.ok(invite.token.length >= 30);
  const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM collaboration.organization_invitations");
  assert.ok(!JSON.stringify(stored.rows).includes(invite.token), "token is stored only as a hash");
  assert.ok(Date.parse(invite.expiresAt) - Date.now() > 6.9 * 864e5, "7 day expiry");

  const inbox = await service.incomingInvitations(C);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].organization.name, "Acme Inc");
  assert.equal(inbox[0].role, "admin");
  assert.deepEqual(await service.incomingInvitations(D), []);

  await rejects(service.acceptById(D, invite.id), 404);
  await rejects(service.decline(D, invite.id), 404);
  await rejects(service.acceptByToken(D, invite.token), 403);
  assert.equal((await service.incomingInvitations(C)).length, 1);

  await service.acceptById(C, invite.id);
  const mine = await teams(service, C);
  assert.equal(mine[0].role, "admin");
  assert.equal((await service.incomingInvitations(C)).length, 0);
  await rejects(service.acceptById(C, invite.id), 404);
  const events = (await db.query<{ event: string }>("SELECT event FROM collaboration.organization_audit_events")).rows.map((r) => r.event);
  assert.deepEqual(events.sort(), ["org.accepted", "org.created", "org.invited"]);
});

test("codes are single-use; decline, cancel and expiry remove access; resend reissues", async (t) => {
  const { db, service, org } = await fixture();
  t.after(() => db.close());
  const first = await service.invite(A, org.id, { email: EMAILS[C] });
  await service.acceptByToken(C, first.token);
  await rejects(service.acceptByToken(C, first.token), 404);

  const declined = await service.invite(A, org.id, { email: EMAILS[D] });
  await service.decline(D, declined.id);
  await rejects(service.acceptByToken(D, declined.token), 404);
  assert.equal((await service.listInvitations(A, org.id)).length, 0);

  const cancelled = await service.invite(A, org.id, { email: EMAILS[D] });
  await service.cancelInvitation(A, org.id, cancelled.id);
  await rejects(service.acceptById(D, cancelled.id), 404);

  const expiring = await service.invite(A, org.id, { email: EMAILS[D] });
  await db.query("UPDATE collaboration.organization_invitations SET expires_at = now() - interval '1 minute'");
  await rejects(service.acceptById(D, expiring.id), 404);
  await rejects(service.acceptByToken(D, expiring.token), 404);
  assert.equal((await service.incomingInvitations(D)).length, 0);
  assert.equal((await service.listInvitations(A, org.id))[0].status, "expired");
  const resent = await service.resendInvitation(A, org.id, expiring.id);
  assert.notEqual(resent.token, expiring.token);
  await rejects(service.acceptByToken(D, expiring.token), 404);
  await service.acceptByToken(D, resent.token);
  assert.equal((await teams(service, D)).length, 1);
});

test("duplicate pending invitations, existing members and bad input are rejected", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await service.invite(A, org.id, { email: "dup@example.com" });
  await rejects(service.invite(A, org.id, { email: " DUP@example.com " }), 409, "already_invited");
  await join(C, "member");
  await rejects(service.invite(A, org.id, { email: EMAILS[C] }), 409, "already_member");
  await rejects(service.invite(A, org.id, { email: EMAILS[A] }), 409, "already_member");
  await rejects(service.invite(A, org.id, { email: "not-an-email" }), 400, "invalid_email");
  await rejects(service.invite(A, org.id, { email: "a@b.co", role: "owner" }), 400, "invalid_role");
  await db.query("UPDATE collaboration.organization_invitations SET expires_at = now() - interval '1 day'");
  await service.invite(A, org.id, { email: "dup@example.com" });
});

test("caps: invitations per day, members per organization, organizations per user", async (t) => {
  const rate = await fixture({ maxInvitationsPerDay: 3 });
  t.after(() => rate.db.close());
  // the fixture's own owner create does not count; invites do
  await rate.service.invite(A, rate.org.id, { email: "p1@example.com" });
  await rate.service.invite(A, rate.org.id, { email: "p2@example.com" });
  const third = await rate.service.invite(A, rate.org.id, { email: "p3@example.com" });
  await rejects(rate.service.invite(A, rate.org.id, { email: "p4@example.com" }), 429, "invitation_rate_limit");
  await rejects(rate.service.resendInvitation(A, rate.org.id, third.id), 429, "invitation_rate_limit");
  await rate.service.cancelInvitation(A, rate.org.id, third.id);
  await rejects(rate.service.invite(A, rate.org.id, { email: "p5@example.com" }), 429, "invitation_rate_limit");
  await rate.db.query("UPDATE collaboration.organization_audit_events SET created_at = now() - interval '25 hours'");
  await rate.service.invite(A, rate.org.id, { email: "p5@example.com" });

  const full = await fixture({ maxMembersPerOrganization: 2 });
  t.after(() => full.db.close());
  await full.join(B, "member");
  await rejects(full.service.invite(A, full.org.id, { email: "z@example.com" }), 409, "organization_full");

  const perUser = await setup({ maxOrganizationsPerUser: 2 });
  t.after(() => perUser.db.close());
  await perUser.service.create(A, { name: "One" });
  const two = await perUser.service.create(A, { name: "Two" });
  await rejects(perUser.service.create(A, { name: "Three" }), 409, "organization_limit");
  // joining counts too: B is in 2 organizations after creating one and accepting one, so a third invite cannot be accepted
  const first = await perUser.service.invite(A, two.id, { email: EMAILS[B] });
  await perUser.service.acceptByToken(B, first.token);
  await perUser.service.create(B, { name: "B own" });
  const other = await perUser.service.create(A, { name: "Three" }).catch(() => null);
  assert.equal(other, null);
  const bOrg = (await teams(perUser.service, B)).find((o) => o.name === "B own")!;
  const invite = await perUser.service.invite(B, bOrg.id, { email: EMAILS[C] });
  await perUser.service.acceptByToken(C, invite.token);
  const cOrg = await perUser.service.create(C, { name: "C own" });
  const back = await perUser.service.invite(C, cOrg.id, { email: EMAILS[B] });
  await rejects(perUser.service.acceptByToken(B, back.token), 409, "organization_limit");
});

test("owner cannot leave without transferring; transfer swaps roles; delete needs the name", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await join(B, "admin");
  await join(C, "member");
  await rejects(service.leave(A, org.id), 409, "owner_must_transfer");
  await service.leave(C, org.id);
  assert.equal((await teams(service, C)).length, 0);
  await rejects(service.transferOwnership(A, org.id, C), 404);
  await service.transferOwnership(A, org.id, B);
  const roles = Object.fromEntries((await service.members(B, org.id)).map((m) => [m.id, m.role]));
  assert.deepEqual(roles, { [A]: "admin", [B]: "owner" });
  await service.leave(A, org.id);
  await rejects(service.remove(A, org.id, "Acme Inc"), 404);
  await rejects(service.remove(B, org.id, "wrong"), 400, "confirmation_mismatch");
  await service.remove(B, org.id, "Acme Inc");
  assert.deepEqual(await teams(service, B), []);
  const events = (await db.query<{ event: string }>("SELECT event FROM collaboration.organization_audit_events")).rows.map((r) => r.event);
  for (const expected of ["org.created", "org.invited", "org.accepted", "org.left", "org.transferred", "org.deleted"]) assert.ok(events.includes(expected), expected);
});

test("removing a member records org.removed and ends their access", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await join(C, "member");
  await service.removeMember(A, org.id, C);
  await rejects(service.members(C, org.id), 404);
  const events = (await db.query<{ event: string }>("SELECT event FROM collaboration.organization_audit_events WHERE event = 'org.removed'")).rows;
  assert.equal(events.length, 1);
});

test("with open sign-up, an unverified email cannot use the inbox or accept by id", async (t) => {
  const ctx = await setup({}, { verified: false, inboxRequiresVerifiedEmail: true });
  t.after(() => ctx.db.close());
  const org = await ctx.service.create(A, { name: "Acme" });
  const invite = await ctx.service.invite(A, org.id, { email: EMAILS[C] });
  assert.deepEqual(await ctx.service.incomingInvitations(C), []);
  await rejects(ctx.service.acceptById(C, invite.id), 403);
  await rejects(ctx.service.decline(C, invite.id), 403);
});

test("HTTP router maps endpoints and leaves task-board routes alone", async (t) => {
  const { db, service } = await setup();
  t.after(() => db.close());
  const call = (userId: string, method: string, pathname: string, body: unknown = {}) =>
    routeOrganizations({ service, userId, method, pathname, readJson: async <T,>() => body as T });
  const created = await call(A, "POST", "/v1/organizations", { name: "Routed" });
  assert.equal(created?.status, 201);
  const id = (created!.body as { organization: { id: string } }).organization.id;
  assert.equal((await call(A, "GET", "/v1/organization-slugs/routed"))?.status, 200);
  assert.equal((await call(A, "POST", `/v1/organizations/${id}/invitations`, { email: EMAILS[B] }))?.status, 201);
  assert.equal(((await call(B, "GET", "/v1/me/organization-invitations"))!.body as { invitations: unknown[] }).invitations.length, 1);
  assert.equal(await call(A, "GET", `/v1/organizations/${id}/boards`), undefined);
  assert.equal(await call(A, "GET", "/v1/task-boards/x"), undefined);
  assert.equal((await call(A, "DELETE", `/v1/organizations/${id}`, { confirm: "Routed" }))?.status, 200);
});

test("personal org: created once, listed first, never counted against the limit", async (t) => {
  const { db, service } = await setup({ maxOrganizationsPerUser: 1 });
  t.after(() => db.close());
  const first = await service.list(A);
  assert.equal(first.length, 1);
  assert.equal(first[0].personal, true);
  assert.equal(first[0].name, "Personal");
  assert.equal(first[0].role, "owner");
  assert.equal(first[0].slug, "");
  assert.equal((await db.query(`SELECT slug FROM collaboration.organizations WHERE id = $1::uuid`, [first[0].id])).rows[0].slug, null);
  // the old personal-<hash> namespace is reserved, so nobody can squat or collide with it
  await rejects(service.create(B, { name: "Squat", slug: "personal-0123abcd" }), 400, "reserved_slug");
  assert.equal((await service.create(B, { name: "Personal Stuff" })).slug.startsWith("personal-"), false);
  assert.deepEqual(first[0].members.map((m) => m.id), [A]);
  const id = await service.ensurePersonal(A);
  assert.equal(id, first[0].id);
  assert.equal(await service.ensurePersonal(A), id);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM collaboration.organizations WHERE personal_owner_id = $1`, [A])).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM collaboration.organization_members WHERE user_id = $1`, [A])).rows[0].n, 1);
  // the limit of 1 still allows one team org on top of the personal one, and personal stays first
  const team = await service.create(A, { name: "Acme Inc" });
  await rejects(service.create(A, { name: "Second" }), 409, "organization_limit");
  const all = await service.list(A);
  assert.deepEqual(all.map((o) => [o.id, o.personal]), [[id, true], [team.id, false]]);
  assert.notEqual((await service.list(B))[0].id, id, "personal orgs are per user");
});

test("personal org: delete, leave, rename, transfer, invite and member changes return 409 personal_org", async (t) => {
  const { db, service } = await setup();
  t.after(() => db.close());
  const id = await service.ensurePersonal(A);
  await rejects(service.remove(A, id, "Personal"), 409, "personal_org");
  await rejects(service.leave(A, id), 409, "personal_org");
    await rejects(service.transferOwnership(A, id, B), 409, "personal_org");
  await rejects(service.invite(A, id, { email: EMAILS[B] }), 409, "personal_org");
  await rejects(service.setMemberRole(A, id, B, "admin"), 409, "personal_org");
  await rejects(service.removeMember(A, id, B), 409, "personal_org");
  // others still cannot see it exists
  await rejects(service.update(B, id, { name: "Mine" }), 404);
  assert.equal((await service.list(A))[0].name, "Personal");
});

test("resolveActive: header must be a membership, no header means personal", async (t) => {
  const { db, service, org } = await fixture();
  t.after(() => db.close());
  const personal = await service.ensurePersonal(A);
  assert.equal(await service.resolveActive(A, undefined), personal);
  assert.equal(await service.resolveActive(A, ""), personal);
  assert.equal(await service.resolveActive(A, org.id), org.id);
  await rejects(service.resolveActive(D, org.id), 404, "organization_not_found");
  await rejects(service.resolveActive(D, "not-a-uuid"), 404, "organization_not_found");
  await rejects(service.resolveActive(D, await service.ensurePersonal(A)), 404, "organization_not_found");
});
